/** QA107 preservation against the original saved baseline. No migrations or database writes. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import pg from 'pg';
import { localDatabase, restoreDatabaseName } from '../server/recovery';

type PreservationState = {
  ids: string[];
  names: string[];
  before: Record<string, string>;
  user_ids: string[];
  users_hash: string;
  created_at: string;
};
type Options = { saveReport?: boolean };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const canonical = (value: any): any =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([k, v]) => [k, canonical(v)]),
        )
      : value;
const simulationTenant = '52f2aff0-5bc7-4454-9bdd-82e333e2c742';
const simulationActor = '401c10c8-2c9d-4ce6-be7c-3be55f741798';
const simulationChannels = [
  '728d4b12-8a88-4125-95c0-308e3bef3798',
  'fd17a7f8-b7ba-49f8-b65a-52e5050d2181',
];
const zeroStats = { checked: 0, queued: 0, skipped: 0, errors: 0 };
const emptySchedule = {
  tenant: 'd8d6ec77-632f-488c-8b6f-e43f8999a9c5',
  actor: 'e2fa38bd-810b-40ed-87b9-10230f021160',
  schedule: 'ad848928-2c61-4e5e-89c4-05d83bd15faa',
  run: '6a0ad327-8464-44d8-8d5b-ab17cbb46ee7',
  job: 'b1b5fd80-9117-4ccd-813e-826656157dfb',
  queueAudit: '2e5a81fd-5722-48ef-a675-3a1de87003a7',
  batchAudit: '02a219ad-afb9-4116-9cf3-9256e13ad91e',
};
class UnsettledScan extends Error {}

async function verifyKnownEmptySchedule(
  c: pg.Client,
  state: PreservationState,
  addedJobs: Record<string, any>[],
) {
  const runs = (
    await c.query(
      'SELECT to_jsonb(r) row,created_at<$2::timestamptz prior FROM automation_schedule_runs r WHERE tenant_id=ANY($1::uuid[]) ORDER BY 1',
      [state.ids, state.created_at],
    )
  ).rows as { row: Record<string, any>; prior: boolean }[];
  const oldRuns = runs.filter((r) => r.prior).map(({ row }) => ({ row }));
  assert.equal(oldRuns.length, 17);
  assert.equal(
    digest(oldRuns),
    state.before.automation_schedule_runs,
    'An original schedule run changed',
  );
  const newRuns = runs.filter((r) => !r.prior).map(({ row }) => row);
  assert.equal(newRuns.length, 1, 'Only the observed empty schedule run may be appended');
  const run = newRuns[0];
  assert.equal(run.id, emptySchedule.run);
  assert.equal(run.tenant_id, emptySchedule.tenant);
  assert.equal(run.schedule_id, emptySchedule.schedule);
  assert.equal(run.actor_id, emptySchedule.actor);
  assert.equal(run.schedule_version, 1);
  assert.equal(run.definition_version, 1);
  assert.equal(run.job_id, emptySchedule.job);
  assert.equal(run.state, 'done');
  for (const field of ['scanned', 'done', 'skipped', 'failed']) assert.equal(run[field], 0);
  for (const field of ['cursor_at', 'cursor_id', 'error'])
    assert(run[field] === null, 'Empty schedule gained a cursor/error');
  assert(typeof run.finished_at === 'string');
  const prior = (
    await c.query(
      'SELECT to_jsonb(r) row FROM automation_schedule_runs r WHERE schedule_id=$1 AND tenant_id=$2 AND created_at<$3::timestamptz ORDER BY created_at DESC,id DESC LIMIT 1',
      [emptySchedule.schedule, emptySchedule.tenant, state.created_at],
    )
  ).rows[0]?.row;
  assert(prior, 'The existing scheduled definition must have a baseline run');
  assert.equal(
    digest(canonical(run.definition)),
    digest(canonical(prior.definition)),
    'The empty run used a different action/consent definition',
  );
  const scheduledJobs = addedJobs.filter((j) => j.kind === 'automation.schedule');
  assert.equal(scheduledJobs.length, 1);
  const job = scheduledJobs[0];
  assert.equal(job.id, emptySchedule.job);
  assert.equal(job.tenant_id, emptySchedule.tenant);
  assert.equal(digest(canonical(job.payload)), digest({ run_id: emptySchedule.run }));
  assert.equal(job.state, 'done');
  assert.equal(job.attempts, 0);
  assert.equal(job.max_attempts, 5);
  assert.equal(job.priority, 100);
  assert.equal(job.dedup_key, 'automation-schedule:' + emptySchedule.run);
  for (const field of [
    'error',
    'lease_token',
    'locked_at',
    'provider_wait_until',
    'provider_wait_reason',
  ])
    assert(job[field] === null, 'Empty schedule job retained an error/lease/provider wait');
  const audits = (
    await c.query(
      'SELECT to_jsonb(a) row,created_at<$2::timestamptz prior FROM audit_events a WHERE tenant_id=ANY($1::uuid[]) ORDER BY 1',
      [state.ids, state.created_at],
    )
  ).rows as { row: Record<string, any>; prior: boolean }[];
  const oldAudits = audits.filter((a) => a.prior).map(({ row }) => ({ row }));
  assert.equal(oldAudits.length, 3076);
  assert.equal(digest(oldAudits), state.before.audit_events, 'An original audit event changed');
  const newAudits = audits.filter((a) => !a.prior).map(({ row }) => row);
  assert.equal(newAudits.length, 2, 'Unexpected audit activity in earlier firms');
  assert.deepEqual(
    newAudits.map((a) => a.id).sort(),
    [emptySchedule.queueAudit, emptySchedule.batchAudit].sort(),
  );
  for (const a of newAudits) {
    assert.equal(a.tenant_id, emptySchedule.tenant);
    assert.equal(a.user_id, emptySchedule.actor);
    assert.equal(a.entity_id, emptySchedule.schedule);
    const queue = a.id === emptySchedule.queueAudit;
    assert.equal(
      a.created_at,
      queue ? run.created_at : run.finished_at,
      'The audit is not part of the known queue/finalization transaction',
    );
    assert.equal(a.action, queue ? 'automation.schedule.queue' : 'automation.schedule.batch');
    assert.equal(
      digest(canonical(a.detail)),
      digest(
        canonical(
          queue
            ? { run_id: emptySchedule.run, version: '1' }
            : { run_id: emptySchedule.run, done: 0, skipped: 0, failed: 0, more: false },
        ),
      ),
      'Audit implies an additional scheduled action',
    );
  }
  const clocks = (
    await c.query(
      `SELECT r.scheduled_for=prior.as_of+interval '3600 seconds' due_exact,
    r.as_of=r.created_at as_of_exact,j.created_at=r.created_at job_created_exact,
    j.run_at=r.finished_at+interval '1 second' job_finished_exact,s.next_at=r.as_of+interval '3600 seconds' next_exact
    FROM automation_schedule_runs r JOIN automation_schedules s ON(s.tenant_id,s.id)=(r.tenant_id,r.schedule_id)
    JOIN jobs j ON(j.tenant_id,j.id)=(r.tenant_id,r.job_id)
    JOIN LATERAL(SELECT as_of FROM automation_schedule_runs previous WHERE previous.tenant_id=r.tenant_id AND previous.schedule_id=r.schedule_id AND previous.created_at<$2::timestamptz ORDER BY previous.created_at DESC,previous.id DESC LIMIT 1) prior ON true WHERE r.id=$1`,
      [emptySchedule.run, state.created_at],
    )
  ).rows[0];
  assert(
    clocks && Object.values(clocks).every((v) => v === true),
    'Scheduled clocks differ from the observed hourly empty execution',
  );
  const originalSchedules = (
    await c.query(
      `SELECT CASE WHEN s.id=$3::uuid THEN to_jsonb(s)||jsonb_build_object('next_at',previous.as_of+interval '3600 seconds') ELSE to_jsonb(s) END row
    FROM automation_schedules s LEFT JOIN LATERAL(SELECT as_of FROM automation_schedule_runs r WHERE r.tenant_id=s.tenant_id AND r.schedule_id=s.id AND r.created_at<$2::timestamptz ORDER BY r.created_at DESC,r.id DESC LIMIT 1) previous ON true WHERE s.tenant_id=ANY($1::uuid[]) ORDER BY 1`,
      [state.ids, state.created_at, emptySchedule.schedule],
    )
  ).rows;
  assert.equal(originalSchedules.length, 3);
  assert.equal(
    digest(originalSchedules),
    state.before.automation_schedules,
    'An existing schedule changed beyond its one next_at clock',
  );
  const effects = (
    await c.query(
      `SELECT (SELECT count(*)::int FROM automation_schedule_items WHERE run_id=$1) items,
    (SELECT count(*)::int FROM automation_schedule_receipts WHERE run_id=$1) receipts,
    (SELECT count(*)::int FROM email_batches WHERE automation_schedule_run_id=$1) email_batches`,
      [emptySchedule.run],
    )
  ).rows[0];
  assert(
    Object.values(effects).every((v) => v === 0),
    'The new empty schedule produced order or email actions',
  );
  return {
    original_audits_exact: oldAudits.length,
    original_schedule_runs_exact: oldRuns.length,
    original_schedules_exact: originalSchedules.length,
    schedule_reconstruction_fields: ['next_at'],
    new_empty_schedule_runs: 1,
    new_empty_schedule_run_id: emptySchedule.run,
    new_empty_schedule_job_id: emptySchedule.job,
    new_empty_schedule_audit_ids: [emptySchedule.queueAudit, emptySchedule.batchAudit],
    new_empty_schedule_counts: { scanned: 0, done: 0, skipped: 0, failed: 0 },
    new_empty_schedule_effects: effects,
  };
}

async function inspect(state: PreservationState, databaseName?: string) {
  assert.equal(state.ids.length, 99, 'Use the original QA107 99-firm baseline');
  assert.equal(state.names.length, 211, 'Keep all original baseline table names');
  assert.equal(new Set(state.names).size, state.names.length);
  for (const table of [
    'jobs',
    'order_status_configs',
    'sessions',
    'tenants',
    'audit_events',
    'automation_schedule_runs',
    'automation_schedules',
  ])
    assert(state.names.includes(table));
  assert(state.ids.includes(simulationTenant));
  assert(state.user_ids.length > 0 && /^[a-f0-9]{64}$/.test(state.users_hash));
  assert(Number.isFinite(Date.parse(state.created_at)));
  const local = localDatabase();
  const database = databaseName === undefined ? local.database : restoreDatabaseName(databaseName);
  const c = new pg.Client({
    ...local,
    database,
    application_name: 'inventory-preservation-readonly',
  });
  await c.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL statement_timeout='8s'");
    // The original baseline serializes timestamptz with this timezone.
    await c.query("SET LOCAL TIME ZONE 'Europe/Warsaw'");
    const jobs = (
      await c.query(
        'SELECT to_jsonb(j) row,created_at<$2::timestamptz prior FROM jobs j WHERE tenant_id=ANY($1::uuid[]) ORDER BY 1',
        [state.ids, state.created_at],
      )
    ).rows as { row: Record<string, any>; prior: boolean }[];
    const previous = jobs.filter((j) => j.prior).map(({ row }) => ({ row }));
    assert.equal(previous.length, 5347, 'Original job inventory changed');
    assert.equal(digest(previous), state.before.jobs, 'A pre-baseline job changed or disappeared');
    const added = jobs.filter((j) => !j.prior).map(({ row }) => row);
    const emptyScheduleReport = await verifyKnownEmptySchedule(c, state, added);
    for (const j of added) {
      if (j.id === emptySchedule.job) continue;
      assert.equal(j.tenant_id, simulationTenant, 'Unexpected tenant gained a background job');
      assert.equal(
        j.kind,
        'order.status.scan',
        'Only the documented empty periodic scan is allowed',
      );
      assert(simulationChannels.includes(j.payload?.channel_id), 'Unexpected scan channel');
      assert.equal(
        digest(canonical(j.payload)),
        digest(
          canonical({
            channel_id: j.payload.channel_id,
            actor_id: simulationActor,
            version: 1,
            after: null,
            stats: zeroStats,
          }),
        ),
        'Scan payload or counters imply additional effects',
      );
      assert.equal(j.max_attempts, 5);
      assert.equal(j.priority, 100);
      assert.equal(j.dedup_key, 'order.status.scan:' + j.id);
      assert(j.error === null, 'New simulation scan reported an error');
      assert.equal(j.provider_wait_until, null);
      assert(j.provider_wait_reason === null, 'New simulation scan entered a provider wait');
      assert(Date.parse(j.run_at) >= Date.parse(j.created_at));
      if (j.state === 'pending') {
        assert.equal(j.attempts, 0);
        assert.equal(j.lease_token, null);
        assert.equal(j.locked_at, null);
      } else if (j.state === 'running') {
        assert.equal(j.attempts, 1);
        assert.equal(typeof j.lease_token, 'string');
        assert.equal(typeof j.locked_at, 'string');
      } else {
        assert.equal(j.state, 'done', 'A scan did not finish successfully');
        assert.equal(j.attempts, 1);
        assert.equal(j.lease_token, null);
        assert.equal(j.locked_at, null);
      }
    }
    const channels = (
      await c.query(
        "SELECT id,tenant_id,provider,mode,status,settings->'simulation'='true'::jsonb simulation FROM channels WHERE id=ANY($1::uuid[]) ORDER BY id",
        [simulationChannels],
      )
    ).rows;
    assert.equal(channels.length, 2);
    for (const channel of channels) {
      assert.equal(channel.tenant_id, simulationTenant);
      assert.equal(channel.mode, 'sandbox');
      assert.equal(channel.status, 'simulation');
      assert.equal(channel.simulation, true);
    }
    assert.deepEqual(channels.map((ch) => ch.provider).sort(), ['allegro', 'woocommerce']);
    const configs = (
      await c.query(
        'SELECT to_jsonb(cfg) row FROM order_status_configs cfg WHERE tenant_id=ANY($1::uuid[]) ORDER BY 1',
        [state.ids],
      )
    ).rows;
    assert.equal(configs.length, 3);
    const enabled = configs.map((r) => r.row).filter((r) => r.enabled);
    assert.deepEqual(enabled.map((r) => r.channel_id).sort(), [...simulationChannels].sort());
    for (const config of enabled) {
      assert.equal(config.tenant_id, simulationTenant);
      assert.equal(config.actor_id, simulationActor);
      assert.equal(config.version, 1);
      assert.equal(config.external_authorized, false);
      assert(config.error === null, 'Enabled simulation configuration reported an error');
      const latest = jobs
        .map(({ row }) => row)
        .filter(
          (j) => j.kind === 'order.status.scan' && j.payload?.channel_id === config.channel_id,
        )
        .find((j) => j.id === config.last_job_id);
      assert(latest, 'The scheduled configuration points outside its own scan history');
      assert.equal(latest.payload.version, config.version);
    }
    // No pending/running scan is accepted as a successful preservation proof. The caller may
    // retry this entire read-only snapshot briefly while the existing worker settles it.
    const scans = added.filter((j) => j.kind === 'order.status.scan');
    if (scans.some((j) => j.state !== 'done'))
      throw new UnsettledScan('A periodic scan is settling');
    const currentClocks = (
      await c.query(
        `SELECT cfg.channel_id,cfg.last_job_id=latest.id job_exact,
         cfg.next_run_at=latest.created_at+interval '60 seconds' next_clock_exact,
         cfg.last_run_at=latest.run_at last_clock_exact
         FROM order_status_configs cfg JOIN LATERAL(
         SELECT j.id,j.created_at,j.run_at FROM jobs j WHERE j.tenant_id=cfg.tenant_id
         AND j.kind='order.status.scan' AND j.payload->>'channel_id'=cfg.channel_id::text
         ORDER BY j.created_at DESC,j.id DESC LIMIT 1) latest ON true
         WHERE cfg.channel_id=ANY($1::uuid[])`,
        [simulationChannels],
      )
    ).rows;
    assert.equal(currentClocks.length, 2);
    for (const clocks of currentClocks)
      assert(
        clocks.job_exact && clocks.next_clock_exact && clocks.last_clock_exact,
        'Current configuration clocks do not exactly match the latest successful periodic scan',
      );
    const reconstructed = (
      await c.query(
        `SELECT CASE WHEN cfg.channel_id=ANY($3::uuid[]) THEN
         to_jsonb(cfg)||jsonb_build_object('next_run_at',previous.created_at+interval '60 seconds',
         'last_run_at',previous.run_at,'last_job_id',previous.id) ELSE to_jsonb(cfg) END row
         FROM order_status_configs cfg LEFT JOIN LATERAL(
         SELECT j.id,j.created_at,j.run_at FROM jobs j WHERE j.tenant_id=cfg.tenant_id
         AND j.kind='order.status.scan' AND j.payload->>'channel_id'=cfg.channel_id::text
         AND j.created_at<$2::timestamptz ORDER BY j.created_at DESC,j.id DESC LIMIT 1
         ) previous ON true WHERE cfg.tenant_id=ANY($1::uuid[]) ORDER BY 1`,
        [state.ids, state.created_at, simulationChannels],
      )
    ).rows;
    assert.equal(
      digest(reconstructed),
      state.before.order_status_configs,
      'Configuration data differ from the original baseline beyond the three documented clocks',
    );
    let verified = 5;
    let sessionsBaselineExact = false;
    for (const table of state.names) {
      assert(/^[a-z][a-z0-9_]*$/.test(table));
      if (
        [
          'jobs',
          'order_status_configs',
          'audit_events',
          'automation_schedule_runs',
          'automation_schedules',
        ].includes(table)
      )
        continue;
      const rows = (
        await c.query(
          `SELECT to_jsonb(t) row FROM "${table}" t WHERE ${table === 'tenants' ? 'id' : 'tenant_id'}=ANY($1::uuid[]) ORDER BY 1`,
          [state.ids],
        )
      ).rows;
      if (table === 'sessions') {
        // Root observed the deliberate QA106 logout in CUA. Do not restore that auth session,
        // or claim equality for this excluded operational table without its original raw rows.
        sessionsBaselineExact = digest(rows) === state.before[table];
        continue;
      }
      assert.equal(digest(rows), state.before[table], 'Earlier firm data changed in ' + table);
      verified++;
    }
    assert.equal(verified, 210);
    const users = (
      await c.query('SELECT to_jsonb(u) row FROM users u WHERE id=ANY($1::uuid[]) ORDER BY id', [
        state.user_ids,
      ])
    ).rows;
    assert.equal(users.length, state.user_ids.length);
    assert.equal(digest(users), state.users_hash, 'Earlier user records changed');
    await c.query('COMMIT');
    return {
      status: 'PASS' as const,
      checked_at: new Date().toISOString(),
      database,
      baseline_at: state.created_at,
      original_firms_verified: state.ids.length,
      original_users_verified: users.length,
      original_tables_verified: verified,
      original_tables_baseline: state.names.length,
      original_jobs_exact: previous.length,
      static_configs_exact: configs.length,
      config_reconstruction_fields: ['next_run_at', 'last_run_at', 'last_job_id'],
      new_empty_simulation_scans: scans.length,
      new_scans_terminal: true,
      new_scans_attempts_each: 1,
      new_scans_stats_each: zeroStats,
      new_scan_first_created_at: scans.map((j) => j.created_at).sort()[0] ?? null,
      new_scan_last_created_at:
        scans
          .map((j) => j.created_at)
          .sort()
          .at(-1) ?? null,
      sessions_baseline_exact: sessionsBaselineExact,
      sessions_changed_by_authorized_QA106_logout: !sessionsBaselineExact,
      sessions_equality_excluded: true,
      sessions_exception_basis:
        'Root observed the authorized QA106 logout; exact session-row preservation is not asserted',
      baseline_replaced: false,
      database_mutations: false,
      ...emptyScheduleReport,
    };
  } finally {
    try {
      await c.query('ROLLBACK');
    } finally {
      await c.end();
    }
  }
}

export async function verifyInventoryPreservation(
  state: PreservationState,
  databaseName?: string,
  options: Options = {},
) {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const report = await inspect(state, databaseName);
      if (options.saveReport)
        await writeFile(
          'docs/inventory-bulk-edit-preservation-detail-qa.json',
          JSON.stringify(report, null, 2) + '\n',
        );
      return report;
    } catch (error) {
      if (!(error instanceof UnsettledScan) || attempt === 9) throw error;
      await setTimeout(150);
    }
  }
  throw new Error('Preservation observation did not settle');
}
