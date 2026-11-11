/** Stage 113 read-only gate: retained original rows, no rebasing or silent normalization. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
import { verifyWmsStocktakesPreservation } from './wms-stocktakes-preservation';
import {
  earlierPurchaseProjection,
  REPLENISHMENT_PO_COLUMNS,
} from './replenishment-preservation-projection';

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const hash = (v: unknown) => sha(JSON.stringify(v));
export async function verifyStocktakeScansPreservation(
  options: {
    catalogExportProfiles?: boolean;
    catalogExportSources?: boolean;
    catalogFileImports?: boolean;
    replenishmentPlans?: boolean;
    replenishmentForecast?: boolean;
  } = {},
) {
  assert(!options.catalogExportSources || options.catalogExportProfiles);
  assert(!options.catalogFileImports || options.catalogExportSources);
  assert(!options.replenishmentPlans || options.catalogFileImports);
  assert(!options.replenishmentForecast || options.replenishmentPlans);
  const priorExtraMigrations = options.catalogFileImports
    ? ([
        '096_catalog_export_profiles',
        '097_catalog_export_sources',
        '098_catalog_file_imports',
      ] as const)
    : options.catalogExportSources
      ? (['096_catalog_export_profiles', '097_catalog_export_sources'] as const)
      : options.catalogExportProfiles
        ? (['096_catalog_export_profiles'] as const)
        : [];
  const extraMigrations = [
    ...priorExtraMigrations,
    ...(options.replenishmentPlans ? ['099_replenishment_plans' as const] : []),
    ...(options.replenishmentForecast ? ['100_replenishment_forecast' as const] : []),
  ];
  const raw = await readFile('data/stocktake-scans-stage113-baseline.json');
  const b = JSON.parse(raw.toString('utf8'));
  const captured = JSON.parse(await readFile('docs/stocktake-scans-baseline-qa.json', 'utf8'));
  assert.equal(sha(raw), captured.original_baseline_sha256, 'Immutable 113 baseline changed');
  assert.equal(b.stage, 113);
  assert.equal(b.baseline_rebased, false);
  assert.equal(
    sha(await readFile('data/wms-stocktakes-stage112-baseline.json')),
    b.original_stage112_baseline_sha256,
  );
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TIME ZONE 'UTC'");
    const older = await verifyWmsStocktakesPreservation({
      transaction: c,
      additionalMigrations: [
        '094_wms_stocktake_scans',
        '095_stocktake_scan_recovery',
        ...extraMigrations,
      ],
    });
    assert.equal(older.status, 'PASS_CORE_AND_SOURCE_TRACED_BACKGROUND');
    const firms = (await c.query('SELECT id FROM tenants ORDER BY id')).rows.map((r) => r.id);
    const users = (await c.query('SELECT id FROM users ORDER BY id')).rows.map((r) => r.id);
    const databases = (await c.query('SELECT datname FROM pg_database ORDER BY datname')).rows.map(
      (r) => r.datname,
    );
    assert(b.firms.every((id: string) => firms.includes(id)));
    assert(b.users.every((id: string) => users.includes(id)));
    assert.deepEqual(databases, b.databases, 'Earlier databases changed');
    const tableNames = (
      await c.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")
    ).rows.map((r) => r.tablename);
    assert.deepEqual(
      tableNames,
      [
        ...b.names,
        'stocktake_scan_receipts',
        ...(options.catalogExportProfiles ? ['catalog_export_profiles'] : []),
        ...(options.catalogFileImports
          ? [
              'catalog_file_import_previews',
              'catalog_file_import_rows',
              'catalog_file_import_executions',
              'catalog_file_import_execution_rows',
            ]
          : []),
        ...(options.replenishmentPlans
          ? [
              'purchasing_source_versions',
              'purchasing_stock_changes',
              'replenishment_policies',
              'replenishment_previews',
              'replenishment_rows',
              'replenishment_executions',
              'replenishment_execution_rows',
            ]
          : []),
      ].sort(),
      'Unknown or missing public table beyond the additive094 receipt table',
    );
    if (options.replenishmentPlans) {
      for (const name of [
        'replenishment_policies',
        'replenishment_previews',
        'replenishment_rows',
        'replenishment_executions',
        'replenishment_execution_rows',
      ]) {
        assert.equal(
          (
            await c.query(`SELECT count(*)::int n FROM "${name}" WHERE tenant_id=ANY($1::uuid[])`, [
              b.firms,
            ])
          ).rows[0].n,
          0,
          'Replenishment business evidence added to protected original firms: ' + name,
        );
      }
    }
    if (options.catalogFileImports) {
      for (const name of [
        'catalog_file_import_previews',
        'catalog_file_import_rows',
        'catalog_file_import_executions',
        'catalog_file_import_execution_rows',
      ]) {
        assert.equal(
          (
            await c.query(
              `SELECT count(*)::int n FROM "${name}"
          WHERE tenant_id=ANY($1::uuid[])`,
              [b.firms],
            )
          ).rows[0].n,
          0,
          'Import evidence added to protected original firms: ' + name,
        );
      }
    }
    const differences = [];
    let exact = 0;
    let migrationProjection = false;
    for (const name of b.names as string[]) {
      assert(/^[a-z][a-z0-9_]*$/.test(name));
      const columns = (
        await c.query(
          "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position",
          [name],
        )
      ).rows.map((r) => r.column_name);
      const expectedColumns =
        options.replenishmentPlans &&
        name === 'purchase_orders' &&
        columns.includes(REPLENISHMENT_PO_COLUMNS[0])
          ? [...b.columns[name], ...REPLENISHMENT_PO_COLUMNS]
          : b.columns[name];
      assert.deepEqual(columns, expectedColumns, 'Undeclared original-column change: ' + name);
      let where = '';
      let args: unknown[] = [];
      if (name === 'tenants' || name === 'users') {
        where = 'WHERE t.id=ANY($1::uuid[])';
        args = [name === 'tenants' ? b.firms : b.users];
      } else if (columns.includes('tenant_id')) {
        where = 'WHERE t.tenant_id=ANY($1::uuid[])';
        args = [b.firms];
      } else if (columns.includes('user_id')) {
        where = 'WHERE t.user_id=ANY($1::uuid[])';
        args = [b.users];
      }
      const projection = await earlierPurchaseProjection(
        c,
        name,
        Boolean(options.replenishmentPlans),
        where,
        args,
      );
      const rows = (
        await c.query(`SELECT ${projection} row FROM "${name}" t ${where} ORDER BY 1`, args)
      ).rows;
      const current = { count: rows.length, sha256: hash(rows) };
      if (hash(current) === hash(b.before[name])) {
        ++exact;
        continue;
      }
      if (name === 'migrations') {
        const projected = rows.filter(
          (r) =>
            ![
              '094_wms_stocktake_scans',
              '095_stocktake_scan_recovery',
              ...extraMigrations,
            ].includes(r.row.name),
        );
        assert.deepEqual(
          { count: projected.length, sha256: hash(projected) },
          b.before[name],
          'Original migration records changed',
        );
        migrationProjection = true;
        continue;
      }
      differences.push({ table: name, before: b.before[name], after: current });
    }
    for (const checkpoint of b.own_checkpoints) {
      assert.equal(
        sha(await readFile(checkpoint.file)),
        checkpoint.sha256,
        'Accepted private 112 checkpoint changed',
      );
      const state = JSON.parse(await readFile(checkpoint.file, 'utf8'));
      for (const [name, fingerprint] of Object.entries(checkpoint.snapshot)) {
        assert(/^[a-z][a-z0-9_]*$/.test(name));
        const key = ['users', 'tenants'].includes(name) ? 'id' : 'tenant_id';
        const id = name === 'users' ? state.user : checkpoint.tenant;
        const rows = (
          await c.query(`SELECT to_jsonb(t) row FROM "${name}" t WHERE ${key}=$1 ORDER BY 1`, [id])
        ).rows;
        assert.deepEqual(
          { count: rows.length, sha256: hash(rows) },
          fingerprint,
          'Accepted 112 own data changed: ' + name,
        );
      }
    }
    let backgroundProof: unknown = null;
    const backgroundNames = [
      'audit_events',
      'automation_schedule_runs',
      'automation_schedules',
      'jobs',
      'listings',
      'odoo_catalog_schedules',
      'odoo_catalog_sync_items',
      'odoo_catalog_sync_runs',
      'order_status_configs',
    ];
    if (differences.length && differences.every((d) => backgroundNames.includes(d.table))) {
      const olderBaseline = JSON.parse(
        await readFile('data/wms-stocktakes-stage112-baseline.json', 'utf8'),
      );
      assert.equal(olderBaseline.firms.length, 105);
      assert(olderBaseline.firms.every((id: string) => b.firms.includes(id)));
      const sourceProven = new Set(
        older.explained
          .filter((r) => r.proof === 'ORIGINAL104_SOURCE_TRACED_AND_QA111_EXACT')
          .map((r) => r.table),
      );
      for (const change of differences)
        assert(
          sourceProven.has(change.table),
          'No independent same-snapshot source proof for ' + change.table,
        );

      // Full retained-row SHA includes every payload, actor and timestamp of all
      // 109 original firms. Do not use captured_at: its JS stamp was saved after
      // the RR snapshot began, so a concurrent append could precede that stamp.
      const retainedProofs: Record<
        string,
        {
          count: number;
          sha256: string;
          appended_count: number;
          appended_outside_proven_105: number;
        }
      > = {};
      for (const name of [
        'audit_events',
        'automation_schedule_runs',
        'jobs',
        'odoo_catalog_sync_runs',
        'odoo_catalog_sync_items',
      ]) {
        const retained = (
          await c.query(
            `WITH retained AS MATERIALIZED (
          SELECT * FROM "${name}" WHERE tenant_id=ANY($1::uuid[])
          ORDER BY created_at,id LIMIT $2
        ) SELECT to_jsonb(t) row FROM retained t ORDER BY 1`,
            [b.firms, b.before[name].count],
          )
        ).rows;
        const original = { count: retained.length, sha256: hash(retained) };
        assert.deepEqual(
          original,
          b.before[name],
          'Original 113 rows changed; append provenance cannot excuse ' + name,
        );
        const appended = (
          await c.query(
            `WITH retained AS MATERIALIZED (
          SELECT id FROM "${name}" WHERE tenant_id=ANY($1::uuid[])
          ORDER BY created_at,id LIMIT $2
        ) SELECT count(*)::int n,
          count(*) FILTER(WHERE NOT t.tenant_id=ANY($3::uuid[]))::int outside
        FROM "${name}" t WHERE t.tenant_id=ANY($1::uuid[])
          AND NOT EXISTS(SELECT 1 FROM retained r WHERE r.id=t.id)`,
            [b.firms, b.before[name].count, olderBaseline.firms],
          )
        ).rows[0];
        assert.equal(appended.outside, 0, 'Unproved new original-firm rows: ' + name);
        if (appended.n)
          assert(
            sourceProven.has(name),
            'Appended rows lack the independent complete source classifier: ' + name,
          );
        retainedProofs[name] = {
          ...original,
          appended_count: appended.n,
          appended_outside_proven_105: appended.outside,
        };
      }

      // These mutable background tables contain no rows in the four additional
      // original firms (including an operator's home). Prove this, and conserve
      // the pre-existing105 count at both baselines; never silently omit them.
      const mutableScope: Record<string, unknown> = {};
      for (const name of [
        'listings',
        'automation_schedules',
        'odoo_catalog_schedules',
        'order_status_configs',
      ]) {
        const counts = (
          await c.query(
            `SELECT count(*)::int n,
          count(*) FILTER(WHERE NOT tenant_id=ANY($2::uuid[]))::int outside
          FROM "${name}" WHERE tenant_id=ANY($1::uuid[])`,
            [b.firms, olderBaseline.firms],
          )
        ).rows[0];
        assert.equal(counts.outside, 0, 'Mutable background rows outside proven105: ' + name);
        assert.equal(
          b.before[name].count,
          olderBaseline.before[name].count,
          'Original113 count does not conserve the proven105 baseline: ' + name,
        );
        assert.equal(counts.n, b.before[name].count, 'Background row count changed: ' + name);
        mutableScope[name] = {
          original113_count: b.before[name].count,
          current_count: counts.n,
          original105_count: olderBaseline.before[name].count,
          rows_outside_proven_105: counts.outside,
        };
      }
      // Due enqueue captures the old locked next_at verbatim in scheduled_for.
      // Preserve every other schedule field and reconstruct only the two fields
      // actually updated by scheduleAutomationsDue. No clock is inferred from
      // JS timestamps or from a manual run; the independent105 proof validates
      // each periodic request hash, exact frozen definition and zero-action job.
      const automationClocks = (
        await c.query(
          `WITH retained AS MATERIALIZED (
        SELECT * FROM automation_schedule_runs WHERE tenant_id=ANY($1::uuid[])
        ORDER BY created_at,id LIMIT $2
      ), appended AS MATERIALIZED (
        SELECT r.* FROM automation_schedule_runs r WHERE r.tenant_id=ANY($1::uuid[])
          AND NOT EXISTS(SELECT 1 FROM retained t WHERE t.id=r.id)
      ) SELECT CASE WHEN first_new.id IS NULL THEN to_jsonb(s)
        ELSE to_jsonb(s)||jsonb_build_object('next_at',first_new.scheduled_for,'error',NULL)
        END row,first_new.id new_run_id,
        (s.enabled AND s.error IS NULL AND latest.id IS NOT NULL
          AND s.next_at=automation_next_at(s.definition->'frequency',latest.created_at)) current_clock_bound,
        NOT EXISTS(SELECT 1 FROM appended r LEFT JOIN jobs j ON (j.tenant_id,j.id)=(r.tenant_id,r.job_id)
          WHERE (r.tenant_id,r.schedule_id)=(s.tenant_id,s.id) AND (
            r.schedule_version IS DISTINCT FROM s.version OR r.definition_version IS DISTINCT FROM s.definition_version
            OR r.actor_id IS DISTINCT FROM s.actor_id OR r.as_of IS DISTINCT FROM r.created_at
            OR r.scheduled_for>r.as_of OR r.state IS DISTINCT FROM 'done'
            OR r.error IS NOT NULL OR r.cursor_at IS NOT NULL OR r.cursor_id IS NOT NULL
            OR r.scanned<>0 OR r.done<>0 OR r.skipped<>0 OR r.failed<>0
            OR r.finished_at IS NULL OR j.id IS NULL OR j.kind IS DISTINCT FROM 'automation.schedule'
            OR j.state IS DISTINCT FROM 'done' OR j.error IS NOT NULL OR j.locked_at IS NOT NULL
            OR j.lease_token IS NOT NULL OR j.attempts<>0
            OR j.payload IS DISTINCT FROM jsonb_build_object('run_id',r.id)
            OR j.dedup_key IS DISTINCT FROM 'automation-schedule:'||r.id::text
            OR j.created_at IS DISTINCT FROM r.created_at
            OR j.run_at IS DISTINCT FROM r.finished_at+interval '1 second'
            OR EXISTS(SELECT 1 FROM automation_schedule_items i WHERE (i.tenant_id,i.run_id)=(r.tenant_id,r.id))
            OR EXISTS(SELECT 1 FROM automation_schedule_receipts x WHERE (x.tenant_id,x.run_id)=(r.tenant_id,r.id))
          )) appended_source_bound
      FROM automation_schedules s LEFT JOIN LATERAL (
        SELECT r.id,r.scheduled_for FROM appended r WHERE (r.tenant_id,r.schedule_id)=(s.tenant_id,s.id)
        ORDER BY r.created_at,r.id LIMIT 1
      ) first_new ON true LEFT JOIN LATERAL (
        SELECT r.id,r.created_at FROM automation_schedule_runs r WHERE (r.tenant_id,r.schedule_id)=(s.tenant_id,s.id)
        ORDER BY r.created_at DESC,r.id DESC LIMIT 1
      ) latest ON true WHERE s.tenant_id=ANY($1::uuid[]) ORDER BY 1`,
          [b.firms, b.before.automation_schedule_runs.count],
        )
      ).rows;
      const reconstructedAutomation = automationClocks.map(({ row }) => ({ row }));
      assert.deepEqual(
        { count: reconstructedAutomation.length, sha256: hash(reconstructedAutomation) },
        b.before.automation_schedules,
        '113 automation schedule changed beyond source-bound next_at/error clocks',
      );
      assert(
        automationClocks.every(
          (r) =>
            r.new_run_id === null ||
            (r.current_clock_bound === true && r.appended_source_bound === true),
        ),
        '113 automation clocks lack exact frozen empty periodic jobs',
      );
      // Reconstruct only the four scheduler clocks from genuine retained completed
      // source jobs. PostgreSQL builds JSON timestamps without losing microseconds.
      // The resulting full config rows must match the immutable 113 SHA exactly.
      const reconstructed = (
        await c.query(
          `WITH retained AS (
        SELECT * FROM jobs WHERE tenant_id=ANY($1::uuid[]) ORDER BY created_at,id LIMIT $2
      ) SELECT CASE WHEN NOT cfg.enabled THEN to_jsonb(cfg)
      ELSE to_jsonb(cfg)||jsonb_build_object('last_run_at',prior.run_at,
        'next_run_at',prior.created_at+interval '60 seconds','last_job_id',prior.id,'error',NULL)
      END row FROM order_status_configs cfg LEFT JOIN LATERAL (
        SELECT j.id,j.created_at,j.run_at FROM retained j
        WHERE j.tenant_id=cfg.tenant_id AND j.kind='order.status.scan' AND j.state='done'
        AND j.error IS NULL AND j.payload->>'channel_id'=cfg.channel_id::text
        AND j.payload->>'version'=cfg.version::text
        ORDER BY j.created_at DESC,j.id DESC LIMIT 1
      ) prior ON true WHERE cfg.tenant_id=ANY($1::uuid[]) ORDER BY 1`,
          [b.firms, b.before.jobs.count],
        )
      ).rows;
      assert.deepEqual(
        { count: reconstructed.length, sha256: hash(reconstructed) },
        b.before.order_status_configs,
        '113 config drift includes something beyond the four source-bound clocks',
      );
      const odooClocks = (
        await c.query(
          `WITH retained AS MATERIALIZED (
        SELECT * FROM odoo_catalog_sync_runs WHERE tenant_id=ANY($1::uuid[])
        ORDER BY created_at,id LIMIT $2
      ) SELECT CASE WHEN appended.id IS NULL OR prior.id IS NULL THEN to_jsonb(cfg)
        ELSE to_jsonb(cfg)||jsonb_build_object('last_run_id',prior.id,
          'last_finished_at',prior.finished_at,
          'next_at',prior.finished_at+make_interval(mins=>cfg.interval_minutes),
          'error',prior.error,'updated_at',prior.finished_at) END row,
        appended.id new_run_id,
        (cfg.last_run_id=latest.id AND cfg.last_finished_at=latest.finished_at
          AND cfg.next_at=latest.finished_at+make_interval(mins=>cfg.interval_minutes)
          AND cfg.error IS NOT DISTINCT FROM latest.error
          AND cfg.updated_at=latest.finished_at) current_clock_bound,
        (prior.id IS NOT NULL AND prior.schedule_version=cfg.version
          AND prior.state IN ('success','partial') AND prior.finished_at IS NOT NULL
          AND j.kind='odoo.catalog.sync' AND j.state='done'
          AND j.payload=jsonb_build_object('run_id',prior.id)
          AND j.run_at=prior.finished_at+interval '1 second') retained_source_bound
      FROM odoo_catalog_schedules cfg LEFT JOIN LATERAL (
        SELECT r.id FROM odoo_catalog_sync_runs r
        WHERE (r.tenant_id,r.channel_id)=(cfg.tenant_id,cfg.channel_id)
          AND NOT EXISTS(SELECT 1 FROM retained t WHERE t.id=r.id)
        ORDER BY r.created_at,r.id LIMIT 1
      ) appended ON true LEFT JOIN LATERAL (
        SELECT r.* FROM retained r
        WHERE (r.tenant_id,r.channel_id)=(cfg.tenant_id,cfg.channel_id)
        ORDER BY r.created_at DESC,r.id DESC LIMIT 1
      ) prior ON true LEFT JOIN jobs j ON (j.tenant_id,j.id)=(prior.tenant_id,prior.job_id)
      LEFT JOIN LATERAL (
        SELECT r.id,r.finished_at,r.error FROM odoo_catalog_sync_runs r
        WHERE (r.tenant_id,r.channel_id)=(cfg.tenant_id,cfg.channel_id)
        ORDER BY r.created_at DESC,r.id DESC LIMIT 1
      ) latest ON true WHERE cfg.tenant_id=ANY($1::uuid[]) ORDER BY 1`,
          [b.firms, b.before.odoo_catalog_sync_runs.count],
        )
      ).rows;
      const reconstructedOdoo = odooClocks.map(({ row }) => ({ row }));
      const exactOdoo =
        hash({ count: reconstructedOdoo.length, sha256: hash(reconstructedOdoo) }) ===
        hash(b.before.odoo_catalog_schedules);
      if (differences.some((d) => d.table === 'odoo_catalog_schedules')) {
        assert(sourceProven.has('odoo_catalog_schedules'));
        assert(
          odooClocks.every(
            (r) =>
              r.new_run_id === null ||
              (r.current_clock_bound === true && r.retained_source_bound === true),
          ),
          'Odoo schedule clocks lack genuine retained/latest source transactions',
        );
      }
      backgroundProof = {
        status: 'PROVEN_RETAINED_113_ROWS_AND_SOURCE_BOUND_BACKGROUND',
        transaction: 'same UTC REPEATABLE READ READ ONLY snapshot as the independent105 gate',
        retained_original113_full_rows: retainedProofs,
        independent_source_proven_tables: differences.map((d) => d.table),
        original_firms_outside_proven_105: b.firms.length - olderBaseline.firms.length,
        mutable_background_count_conservation: mutableScope,
        reconstructed_config_sha256: hash(reconstructed),
        clock_fields: ['last_run_at', 'next_run_at', 'last_job_id', 'error'],
        order_status_configs_original113_reconstruction_exact: true,
        automation_schedule: {
          original113_count: b.before.automation_schedules.count,
          original113_sha256: b.before.automation_schedules.sha256,
          reconstructed113_sha256: hash(reconstructedAutomation),
          original113_reconstruction_exact: true,
          clock_fields: ['next_at', 'error'],
          proof: 'EXACT113_SOURCE_CLOCK_RECONSTRUCTION_WITH_RETAINED_RUNS_AND_TERMINAL_EMPTY_JOBS',
          source:
            'server/automation-schedules.ts: scheduleAutomationsDue/enqueueSchedule/processSchedule',
        },
        odoo_schedule: {
          original113_count: b.before.odoo_catalog_schedules.count,
          original113_sha256: b.before.odoo_catalog_schedules.sha256,
          reconstructed113_sha256: hash(reconstructedOdoo),
          original113_reconstruction_exact: exactOdoo,
          proof: exactOdoo
            ? 'EXACT113_SOURCE_CLOCK_RECONSTRUCTION'
            : sourceProven.has('odoo_catalog_schedules')
              ? 'SEPARATE_ORIGINAL105_SOURCE_BOUND_CLOCK_PROOF_NOT113_RAW_EXACT'
              : 'RAW113_EXACT_NO_SCHEDULE_DRIFT',
          clock_fields: ['last_run_id', 'last_finished_at', 'next_at', 'error', 'updated_at'],
        },
        listings: {
          original113_raw_sha_reconstructed: false,
          proof: differences.some((d) => d.table === 'listings')
            ? 'SEPARATE_ORIGINAL105_PROTECTED_PAYLOAD_AND_TWO_OBSERVATION_FIELDS'
            : 'RAW113_EXACT_NO_LISTING_DRIFT',
          allowed_observation_fields: [
            'last_result.odoo_catalog_sync.run_id',
            'last_result.odoo_catalog_sync.observed_at',
          ],
          limitation:
            '113 baseline stores count/SHA, not original listing rows. The independent105 verifier proves complete older payloads and exact source-bound observation changes; this does not reconstruct the113 raw listing SHA.',
        },
        append_provenance:
          'Every new audit/job/automation run/Odoo run/item is within the independent105 gate, which proves complete frozen periodic definitions, zero candidates/actions, local-simulation run/job/config/item/audit bindings and canonical terminal state; all original109 prefix rows remain fully exact.',
        unknown_names_tenants_or_changes_accepted: 0,
      };
    }
    await c.query('COMMIT');
    return {
      stage: 113,
      status: differences.length
        ? backgroundProof
          ? 'PASS_WITH_SOURCE_BOUND_LOCAL_JOBS'
          : 'RAW_DRIFT_REQUIRES_REVIEW'
        : 'PASS_EXACT_ORIGINAL_ROWS',
      baseline_file: 'data/stocktake-scans-stage113-baseline.json',
      original_baseline_sha256: sha(raw),
      baseline_rebased: false,
      prior_firms: b.firms.length,
      current_firms: firms.length,
      prior_users: b.users.length,
      current_users: users.length,
      prior_databases: databases.length,
      compared_tables: b.names.length,
      raw_exact_tables: exact,
      additive_094_095_migration_projection: migrationProjection,
      raw_differences: differences,
      earlier_105_preservation: older.status,
      background_proof: backgroundProof,
      accepted_stage112_checkpoints_exact: b.own_checkpoints.length,
      goal_complete: false,
    };
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
}
if (process.argv[1]?.endsWith('/stocktake-scans-preservation.ts')) {
  try {
    const label = process.argv[2];
    assert(label && /^[a-z0-9-]+$/.test(label));
    const report = await verifyStocktakeScansPreservation();
    await writeFile(
      'docs/stocktake-scans-preservation-' + label + '.json',
      JSON.stringify(report, null, 2) + '\n',
      { flag: 'wx' },
    );
    console.log({
      status: report.status,
      prior_firms: report.prior_firms,
      current_firms: report.current_firms,
      raw_exact_tables: report.raw_exact_tables,
      raw_differences: report.raw_differences.map((d) => d.table),
      accepted_stage112_checkpoints_exact: report.accepted_stage112_checkpoints_exact,
    });
    assert(
      ['PASS_EXACT_ORIGINAL_ROWS', 'PASS_WITH_SOURCE_BOUND_LOCAL_JOBS'].includes(report.status),
    );
  } finally {
    await pool.end();
  }
}
