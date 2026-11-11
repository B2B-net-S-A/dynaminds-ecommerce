/** Read-only classification of seven named background drifts; never rebase or repair data. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { PoolClient } from 'pg';
import type { WmsTraceBaseline } from './wms-lots-preservation-trace';

type Json = Record<string, any>;
type Row = { row: Json };
type Fingerprint = { count: number; sha256: string };
export type WmsBackgroundBaseline = WmsTraceBaseline & { listing_rows: Row[] };
export type WmsBackgroundTableProof = {
  table: string;
  status: 'RAW_EXACT' | 'PROVEN_BACKGROUND_APPEND' | 'PROVEN_EXACT_RECONSTRUCTION' | 'NOT_PROVEN';
  original_count: number;
  current_count: number;
  appended_count: number;
  original_sha256: string;
  reconstructed_sha256: string | null;
  original_raw_exact: boolean;
  every_appended_row_source_bound: boolean;
  reasons: string[];
};
const tables = [
  'audit_events', 'automation_schedule_runs', 'automation_schedules', 'listings',
  'odoo_catalog_schedules', 'odoo_catalog_sync_items', 'odoo_catalog_sync_runs',
] as const;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fp = (rows: Row[]): Fingerprint => ({ count: rows.length, sha256: hash(rows) });
const equal = (a: unknown, b: unknown) => hash(a) === hash(b);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/**
 * Caller supplies its existing UTC REPEATABLE READ READ ONLY transaction.
 * No SQL with side effects, provider calls, files written, or complete rows returned.
 * Jobs/configs remain the separate preservation-trace helper's responsibility.
 */
export async function verifyWmsLotsBackgroundProvenance(
  c: PoolClient,
  baseline: WmsBackgroundBaseline,
) {
  const saved = await readFile('data/wms-lots-stage111-baseline.json', 'utf8');
  assert.deepEqual(baseline, JSON.parse(saved), 'Caller must use the immutable original baseline');
  assert.equal(baseline.stage, 111);
  assert.equal(baseline.baseline_rebased, false);
  assert(Array.isArray(baseline.listing_rows), 'Original listing rows are required');
  assert(Number.isFinite(Date.parse(baseline.captured_at)));
  assert(baseline.firms.length > 0 && baseline.firms.every((id) => uuid.test(id)));
  assert.equal(new Set(baseline.firms).size, baseline.firms.length);
  const context = (await c.query(`SELECT current_setting('TimeZone') timezone,
    current_setting('transaction_isolation') isolation,
    current_setting('transaction_read_only') read_only`)).rows[0];
  assert.equal(context.timezone, 'UTC');
  assert.equal(context.isolation, 'repeatable read');
  assert.equal(context.read_only, 'on');
  // SET LOCAL UTC changes setting, not the authoritative connection reset/default.
  // enqueueSchedule hashed next_at::text in that original pool timezone.
  const sourceSettings = (await c.query(`SELECT
    (SELECT reset_val FROM pg_settings WHERE name='TimeZone') AS timezone,
    (SELECT reset_val FROM pg_settings WHERE name='DateStyle') AS date_style`)).rows[0];
  assert(typeof sourceSettings.timezone === 'string' && sourceSettings.timezone.length > 0);
  assert(typeof sourceSettings.date_style === 'string' && sourceSettings.date_style.startsWith('ISO,'),
    'Exact due_at text reconstruction requires the source ISO DateStyle');
  for (const table of tables) {
    const f = baseline.before[table];
    assert(Number.isSafeInteger(f.count) && f.count >= 0);
    assert.match(f.sha256, /^[a-f0-9]{64}$/);
  }
  const params = [baseline.firms, baseline.captured_at];
  const current = new Map<string, Row[]>();
  for (const table of tables) {
    current.set(table, (await c.query(
      `SELECT to_jsonb(t) row FROM "${table}" t WHERE tenant_id=ANY($1::uuid[]) ORDER BY 1`,
      [baseline.firms],
    )).rows);
  }
  const retained = new Map<string, Row[]>();
  const appended = new Map<string, Row[]>();
  for (const table of ['audit_events', 'automation_schedule_runs', 'odoo_catalog_sync_runs', 'odoo_catalog_sync_items']) {
    retained.set(table, (await c.query(
      `SELECT to_jsonb(t) row FROM "${table}" t
       WHERE tenant_id=ANY($1::uuid[]) AND created_at<=$2::timestamptz ORDER BY 1`, params,
    )).rows);
    appended.set(table, (await c.query(
      `SELECT to_jsonb(t) row FROM "${table}" t
       WHERE tenant_id=ANY($1::uuid[]) AND created_at>$2::timestamptz ORDER BY 1`, params,
    )).rows);
  }

  // A periodic automation run records the previous next_at in scheduled_for.
  // Its request hash distinguishes this call from a manual enqueue.
  const automationBindings = (await c.query(`SELECT r.id,
      r.schedule_version::text AS version_text,
      to_char(original.local_due,'YYYY-MM-DD HH24:MI:SS')
        ||CASE WHEN rtrim(to_char(original.local_due,'US'),'0')='' THEN ''
          ELSE '.'||rtrim(to_char(original.local_due,'US'),'0') END
        ||CASE WHEN original.offset_seconds>=0 THEN '+' ELSE '-' END
        ||lpad((abs(original.offset_seconds)/3600)::text,2,'0')
        ||CASE WHEN abs(original.offset_seconds)%3600<>0 THEN
          ':'||lpad(((abs(original.offset_seconds)%3600)/60)::text,2,'0') ELSE '' END
        ||CASE WHEN abs(original.offset_seconds)%60<>0 THEN
          ':'||lpad((abs(original.offset_seconds)%60)::text,2,'0') ELSE '' END AS due_at_text,
      r.request_hash,
      (j.id IS NOT NULL AND j.kind='automation.schedule' AND j.state='done'
        AND j.payload=jsonb_build_object('run_id',r.id)
        AND j.dedup_key='automation-schedule:'||r.id::text
        AND j.created_at=r.created_at AND r.as_of=r.created_at AND r.scheduled_for<=r.created_at
        AND j.created_at>$2::timestamptz AND r.state='done'
        AND r.finished_at>=r.created_at AND r.finished_at<=current_timestamp
        AND r.scanned=0 AND r.done=0 AND r.skipped=0 AND r.failed=0
        AND NOT EXISTS(SELECT 1 FROM automation_schedule_items i
          WHERE (i.tenant_id,i.run_id)=(r.tenant_id,r.id))
        AND j.run_at=r.finished_at+interval '1 second'
        AND s.enabled AND s.version=r.schedule_version
        AND s.definition_version=r.definition_version AND s.actor_id=r.actor_id
      ) AS linked
    FROM automation_schedule_runs r
    LEFT JOIN jobs j ON (j.tenant_id,j.id)=(r.tenant_id,r.job_id)
    LEFT JOIN automation_schedules s ON (s.tenant_id,s.id)=(r.tenant_id,r.schedule_id)
    CROSS JOIN LATERAL (SELECT r.scheduled_for AT TIME ZONE $3::text AS local_due,
      extract(epoch FROM ((r.scheduled_for AT TIME ZONE $3::text)
        -(r.scheduled_for AT TIME ZONE 'UTC')))::integer AS offset_seconds) original
    WHERE r.tenant_id=ANY($1::uuid[]) AND r.created_at>$2::timestamptz`,
    [...params, sourceSettings.timezone])).rows;
  const automationRunBound = new Map<string, boolean>(automationBindings.map((r) => [r.id,
    r.linked === true && r.request_hash === hash({ version: r.version_text, due_at: r.due_at_text }),
  ]));

  const odooBindings = (await c.query(`SELECT r.id,r.schedule_version,r.input_hash,
      (j.id IS NOT NULL AND j.kind='odoo.catalog.sync' AND j.state='done'
        AND j.payload=jsonb_build_object('run_id',r.id)
        AND j.dedup_key='odoo-catalog:'||r.id::text AND j.created_at=r.created_at
        AND j.created_at>$2::timestamptz AND r.state IN ('success','partial')
        AND r.finished_at>=r.created_at AND r.finished_at<=current_timestamp
        AND j.run_at=r.finished_at+interval '1 second'
        AND s.enabled AND s.version=r.schedule_version AND s.actor_id=r.actor_id
        AND s.prices=r.prices AND s.connection_hash=r.connection_hash
        AND r.total=(SELECT count(*) FROM odoo_catalog_sync_items i
          WHERE (i.tenant_id,i.run_id)=(r.tenant_id,r.id))
        AND r.applied=(SELECT count(*) FROM odoo_catalog_sync_items i
          WHERE (i.tenant_id,i.run_id)=(r.tenant_id,r.id) AND i.state='applied')
        AND r.skipped=(SELECT count(*) FROM odoo_catalog_sync_items i
          WHERE (i.tenant_id,i.run_id)=(r.tenant_id,r.id) AND i.state='skipped')
        AND NOT EXISTS(SELECT 1 FROM odoo_catalog_sync_items i
          WHERE (i.tenant_id,i.run_id)=(r.tenant_id,r.id)
            AND i.captured_at IS DISTINCT FROM r.finished_at)
      ) AS linked
    FROM odoo_catalog_sync_runs r
    LEFT JOIN jobs j ON (j.tenant_id,j.id)=(r.tenant_id,r.job_id)
    LEFT JOIN odoo_catalog_schedules s ON (s.tenant_id,s.channel_id)=(r.tenant_id,r.channel_id)
    WHERE r.tenant_id=ANY($1::uuid[]) AND r.created_at>$2::timestamptz`, params)).rows;
  const odooRunBound = new Map<string, boolean>(odooBindings.map((r) => [r.id,
    r.linked === true && r.input_hash === hash({ version: r.schedule_version }),
  ]));
  const newOdooRuns = new Map<string, Json>((appended.get('odoo_catalog_sync_runs') ?? []).map(({ row }) => [row.id, row]));
  const newOdooItems = new Map<string, Json>((appended.get('odoo_catalog_sync_items') ?? []).map(({ row }) => [row.id, row]));

  const itemBindings = (await c.query(`SELECT i.id,
      (r.id IS NOT NULL AND i.created_at=r.created_at AND i.captured_at IS NOT NULL
        AND i.captured_at>=r.created_at AND i.captured_at<=r.finished_at
        AND i.state IN ('applied','skipped')
        AND (i.state<>'applied' OR (i.result IS NOT NULL AND i.error IS NULL))
        AND l.id IS NOT NULL AND l.channel_id=r.channel_id
        AND (l.product_id,l.external_id)=(i.product_id,i.external_id)
      ) AS linked
    FROM odoo_catalog_sync_items i
    LEFT JOIN odoo_catalog_sync_runs r ON (r.tenant_id,r.id)=(i.tenant_id,i.run_id)
    LEFT JOIN listings l ON (l.tenant_id,l.id)=(i.tenant_id,i.listing_id)
    WHERE i.tenant_id=ANY($1::uuid[]) AND i.created_at>$2::timestamptz`, params)).rows;
  const itemBound = new Map<string, boolean>(itemBindings.map((r) => [r.id,
    r.linked === true && odooRunBound.get(newOdooItems.get(r.id)?.run_id) === true,
  ]));

  // Bind every new audit to a specific new run and its transaction, not merely its label.
  const auditBindings = (await c.query(`SELECT a.id,
      EXISTS(SELECT 1 FROM automation_schedule_runs r JOIN jobs j
        ON (j.tenant_id,j.id)=(r.tenant_id,r.job_id)
        WHERE r.tenant_id=a.tenant_id AND r.created_at>$2::timestamptz
          AND a.entity_id=r.schedule_id AND a.user_id=r.actor_id
          AND a.detail->>'run_id'=r.id::text
          AND ((a.action='automation.schedule.queue' AND a.created_at=r.created_at
            AND a.detail=jsonb_build_object('run_id',r.id,'version',r.schedule_version::text))
          OR (a.action='automation.schedule.batch' AND a.created_at=r.finished_at
            AND r.state='done' AND a.detail=jsonb_build_object('run_id',r.id,
              'done',r.done,'skipped',r.skipped,'failed',r.failed,'more',false))))
      OR EXISTS(SELECT 1 FROM odoo_catalog_sync_runs r
        WHERE r.tenant_id=a.tenant_id AND r.created_at>$2::timestamptz
          AND a.entity_id=r.id AND a.user_id=r.actor_id
          AND ((a.action='odoo.catalog.sync.queue' AND a.created_at=r.created_at
            AND a.detail=jsonb_build_object('channel_id',r.channel_id,'prices',r.prices,
              'mapped_variants',r.total,'scope',CASE WHEN r.simulation THEN 'local_simulation'
              ELSE 'external_read_local_write' END))
          OR (a.action='odoo.catalog.sync.page' AND a.created_at=r.finished_at
            AND a.detail=jsonb_build_object('count',r.total,'applied',r.applied,
              'skipped',r.skipped,'pending',0,'state',r.state)))) AS linked
    FROM audit_events a WHERE a.tenant_id=ANY($1::uuid[]) AND a.created_at>$2::timestamptz`, params)).rows;
  const auditBound = new Map<string, boolean>(auditBindings.map((r) => [r.id, r.linked === true]));
  // EXISTS alone would accept arbitrarily many duplicate queue/final audits.
  // This evidence scope is an empty automation run and one Odoo page: exactly
  // one of each documented audit is required, including when an audit is missing.
  const newAudits = (appended.get('audit_events') ?? []).map(({ row }) => row);
  let auditCardinalityExact = true;
  for (const { row: run } of appended.get('automation_schedule_runs') ?? []) {
    const queueCount = newAudits.filter((a) => a.tenant_id === run.tenant_id &&
      a.action === 'automation.schedule.queue' && a.detail?.run_id === run.id).length;
    const batchCount = newAudits.filter((a) => a.tenant_id === run.tenant_id &&
      a.action === 'automation.schedule.batch' && a.detail?.run_id === run.id).length;
    const exact = queueCount === 1 && batchCount === 1;
    auditCardinalityExact &&= exact;
    automationRunBound.set(run.id, automationRunBound.get(run.id) === true && exact);
  }
  for (const run of newOdooRuns.values()) {
    const queueCount = newAudits.filter((a) => a.tenant_id === run.tenant_id &&
      a.action === 'odoo.catalog.sync.queue' && a.entity_id === run.id).length;
    const pageCount = newAudits.filter((a) => a.tenant_id === run.tenant_id &&
      a.action === 'odoo.catalog.sync.page' && a.entity_id === run.id).length;
    const exact = queueCount === 1 && pageCount === 1;
    auditCardinalityExact &&= exact;
    odooRunBound.set(run.id, odooRunBound.get(run.id) === true && exact);
  }
  for (const item of newOdooItems.values())
    itemBound.set(item.id, itemBound.get(item.id) === true && odooRunBound.get(item.run_id) === true);
  // Audit linkage must additionally refer to a run whose full job/config binding passed.
  for (const { row } of appended.get('audit_events') ?? []) {
    const bound = row.action.startsWith('automation.schedule.')
      ? automationRunBound.get(row.detail?.run_id) === true
      : row.action.startsWith('odoo.catalog.sync.') && odooRunBound.get(row.entity_id) === true;
    auditBound.set(row.id, auditBound.get(row.id) === true && bound);
  }

  const proofs: WmsBackgroundTableProof[] = [];
  function result(table: string, reconstructed: Row[] | null, sourceBound: boolean, reasons: string[], appendCount = 0) {
    const original = baseline.before[table];
    const actual = fp(current.get(table)!);
    const exact = reconstructed !== null && equal(fp(reconstructed), original);
    const rawExact = equal(actual, original);
    const proof: WmsBackgroundTableProof = {
      table,
      status: exact && sourceBound && reasons.length === 0
        ? rawExact ? 'RAW_EXACT' : appendCount ? 'PROVEN_BACKGROUND_APPEND' : 'PROVEN_EXACT_RECONSTRUCTION'
        : 'NOT_PROVEN',
      original_count: original.count, current_count: actual.count, appended_count: appendCount,
      original_sha256: original.sha256,
      reconstructed_sha256: reconstructed === null ? null : fp(reconstructed).sha256,
      original_raw_exact: rawExact, every_appended_row_source_bound: sourceBound,
      reasons: [...reasons, ...(exact ? [] : ['Original whole-table count/SHA was not reconstructed exactly'])],
    };
    proofs.push(proof);
  }
  for (const [table, bindings] of [
    ['automation_schedule_runs', automationRunBound], ['odoo_catalog_sync_runs', odooRunBound],
    ['odoo_catalog_sync_items', itemBound], ['audit_events', auditBound],
  ] as const) {
    const added = appended.get(table)!;
    const bound = added.every(({ row }) => bindings.get(row.id) === true) &&
      (table !== 'audit_events' || auditCardinalityExact);
    result(table, retained.get(table)!, bound,
      bound ? [] : [table === 'audit_events' && !auditCardinalityExact
        ? 'Source run queue/final audit cardinality is not exactly one each (missing or duplicated)'
        : 'At least one appended row lacks an exact documented background run/job/transaction binding'], added.length);
  }

  // The first appended scheduled_for is the old next_at, captured under the schedule lock.
  // Due enqueue changes error and next_at only; all other fields remain in current JSON.
  const automaticSchedules = (await c.query(`SELECT
      CASE WHEN n.id IS NULL THEN to_jsonb(s) ELSE to_jsonb(s)||jsonb_build_object(
        'next_at',n.scheduled_for,'error',NULL) END AS row,n.id AS new_run_id,
      latest.id AS latest_run_id,
      (s.error IS NULL AND s.next_at=automation_next_at(s.definition->'frequency',latest.created_at))
        AS current_clock_bound
    FROM automation_schedules s LEFT JOIN LATERAL (
      SELECT r.id,r.scheduled_for FROM automation_schedule_runs r
      WHERE (r.tenant_id,r.schedule_id)=(s.tenant_id,s.id)
        AND r.created_at>$2::timestamptz
      ORDER BY r.created_at,r.id LIMIT 1
    ) n ON true LEFT JOIN LATERAL (
      SELECT r.id,r.created_at FROM automation_schedule_runs r
      WHERE (r.tenant_id,r.schedule_id)=(s.tenant_id,s.id)
        AND r.created_at>$2::timestamptz ORDER BY r.created_at DESC,r.id DESC LIMIT 1
    ) latest ON true WHERE s.tenant_id=ANY($1::uuid[]) ORDER BY 1`, params)).rows;
  const automationSchedulesBound = automaticSchedules.every((row) =>
    row.new_run_id === null || (automationRunBound.get(row.new_run_id) === true &&
      automationRunBound.get(row.latest_run_id) === true && row.current_clock_bound === true),
  );
  result('automation_schedules', automaticSchedules.map(({ row }) => ({ row })),
    automationSchedulesBound,
    automationSchedulesBound ? [] : ['First/latest appended periodic runs do not prove both original and current schedule clocks']);

  // Final successful page TX stores finished_at and updates all five schedule clocks.
  // A later catch-up reconciliation can use another updated_at; in that case SHA
  // deliberately fails. No alternate timestamp or run is searched for a matching hash.
  const odooSchedules = (await c.query(`SELECT
      CASE WHEN n.id IS NULL OR old.id IS NULL THEN to_jsonb(s)
        ELSE to_jsonb(s)||jsonb_build_object('last_run_id',old.id,
          'last_finished_at',old.finished_at,
          'next_at',old.finished_at+make_interval(mins=>s.interval_minutes),
          'error',old.error,'updated_at',old.finished_at) END AS row,
      n.id AS new_run_id,old.id AS old_run_id,latest.id AS latest_run_id,
      (s.last_run_id=latest.id AND s.last_finished_at=latest.finished_at
        AND s.next_at=latest.finished_at+make_interval(mins=>s.interval_minutes)
        AND s.error IS NOT DISTINCT FROM latest.error AND s.updated_at=latest.finished_at)
        AS current_clocks_bound,
      (old.id IS NOT NULL AND old.schedule_version=s.version
        AND old.state IN ('success','partial') AND old.finished_at<=$2::timestamptz
        AND j.kind='odoo.catalog.sync' AND j.state='done'
        AND j.payload=jsonb_build_object('run_id',old.id)
        AND j.run_at=old.finished_at+interval '1 second') AS old_source_bound
    FROM odoo_catalog_schedules s LEFT JOIN LATERAL (
      SELECT r.id FROM odoo_catalog_sync_runs r
      WHERE (r.tenant_id,r.channel_id)=(s.tenant_id,s.channel_id)
        AND r.created_at>$2::timestamptz ORDER BY r.created_at,r.id LIMIT 1
    ) n ON true LEFT JOIN LATERAL (
      SELECT r.id,r.finished_at,r.error FROM odoo_catalog_sync_runs r
      WHERE (r.tenant_id,r.channel_id)=(s.tenant_id,s.channel_id)
        AND r.created_at>$2::timestamptz ORDER BY r.created_at DESC,r.id DESC LIMIT 1
    ) latest ON true LEFT JOIN LATERAL (
      SELECT r.* FROM odoo_catalog_sync_runs r
      WHERE (r.tenant_id,r.channel_id)=(s.tenant_id,s.channel_id)
        AND r.created_at<=$2::timestamptz ORDER BY r.created_at DESC,r.id DESC LIMIT 1
    ) old ON true LEFT JOIN jobs j ON (j.tenant_id,j.id)=(old.tenant_id,old.job_id)
    WHERE s.tenant_id=ANY($1::uuid[]) ORDER BY 1`, params)).rows;
  const odooSchedulesBound = odooSchedules.every((row) => row.new_run_id === null ||
    (odooRunBound.get(row.new_run_id) === true && odooRunBound.get(row.latest_run_id) === true &&
      row.old_source_bound === true && row.current_clocks_bound === true));
  result('odoo_catalog_schedules', odooSchedules.map(({ row }) => ({ row })),
    odooSchedulesBound,
    odooSchedulesBound ? [] : ['Original/new final transactions cannot prove every original and current schedule clock']);

  // The immutable listing rows are validated against their own original raw SHA.
  // Only the run identifier and observation timestamp in odoo_catalog_sync may differ.
  const originals = baseline.listing_rows;
  const canonicalOriginals: Row[] = (await c.query(
    'SELECT value row FROM jsonb_array_elements($1::jsonb) v(value) ORDER BY 1',
    [JSON.stringify(originals.map(({ row }) => row))],
  )).rows;
  const listingReasons: string[] = [];
  if (!equal(fp(canonicalOriginals), baseline.before.listings))
    listingReasons.push('Saved listing_rows do not match the immutable original listing count/SHA');
  const originalById = new Map(originals.map(({ row }) => [row.id, row]));
  if (originalById.size !== originals.length) listingReasons.push('Original listing IDs are not unique');
  const normalized: Row[] = [];
  let changedListings = 0;
  for (const { row } of current.get('listings')!) {
    const old = originalById.get(row.id);
    if (!old) { listingReasons.push('An original-tenant listing has no saved original row'); normalized.push({ row }); continue; }
    if (equal(row, old)) { normalized.push({ row }); continue; }
    changedListings++;
    const observation = row.last_result?.odoo_catalog_sync;
    const oldObservation = old.last_result?.odoo_catalog_sync;
    const run = newOdooRuns.get(observation?.run_id);
    const candidates = [...newOdooItems.values()].filter((i) =>
      i.tenant_id === row.tenant_id && i.run_id === observation?.run_id && i.listing_id === row.id,
    );
    const item = candidates.length === 1 ? candidates[0] : undefined;
    const observedFields = observation && typeof observation === 'object'
      ? Object.fromEntries(Object.entries(observation).filter(([key]) => !['run_id', 'observed_at'].includes(key))) : null;
    // Source writes JavaScript Date.toISOString(), but PostgreSQL compares the
    // clocks so run microseconds and caller transaction time are not rounded.
    const observedText = observation?.observed_at;
    const validObservedText = typeof observedText === 'string' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(observedText) &&
      Number.isFinite(Date.parse(observedText)) && new Date(observedText).toISOString() === observedText;
    const observedTimeBound = run && validObservedText && (await c.query(
      `SELECT $1::timestamptz>=r.created_at AND $1::timestamptz<=current_timestamp AS bound
       FROM odoo_catalog_sync_runs r WHERE (r.tenant_id,r.id)=($2::uuid,$3::uuid)`,
      [observedText, run.tenant_id, run.id],
    )).rows[0]?.bound === true;
    const bound = run && item && oldObservation &&
      odooRunBound.get(run.id) === true && itemBound.get(item.id) === true && item.state === 'applied' &&
      run.tenant_id === row.tenant_id && run.channel_id === row.channel_id &&
      item.product_id === row.product_id && item.external_id === row.external_id &&
      equal(observedFields, item.result) && row.price === item.result?.price &&
      row.price_currency === item.result?.currency && observedTimeBound;
    if (!bound) listingReasons.push('Changed listing observation lacks an exact appended Odoo run/item binding');
    const restored = structuredClone(row);
    if (observation && oldObservation) {
      restored.last_result.odoo_catalog_sync.run_id = oldObservation.run_id;
      restored.last_result.odoo_catalog_sync.observed_at = oldObservation.observed_at;
    }
    if (!equal(restored, old)) listingReasons.push('Listing differs beyond the two documented Odoo observation fields');
    normalized.push({ row: restored });
  }
  const canonicalListings: Row[] = (await c.query(
    'SELECT value row FROM jsonb_array_elements($1::jsonb) v(value) ORDER BY 1',
    [JSON.stringify(normalized.map(({ row }) => row))],
  )).rows;
  result('listings', canonicalListings, listingReasons.length === 0, [...new Set(listingReasons)]);

  return {
    stage: 111,
    status: proofs.every((proof) => proof.status !== 'NOT_PROVEN') ? 'PROVEN_BACKGROUND_PROVENANCE' : 'NOT_PROVEN',
    baseline_rebased: false,
    original_baseline_sha256: createHash('sha256').update(saved).digest('hex'),
    baseline_capture: baseline.captured_at,
    source_due_timezone: sourceSettings.timezone,
    source_due_date_style: sourceSettings.date_style,
    source_settings_origin: 'pg_settings reset_val; verifier transaction remains UTC',
    tables: proofs,
    changed_listing_observations: changedListings,
    checked_tables: tables.length,
    source_audit_cardinality_exact: auditCardinalityExact,
    unproven_tables: proofs.filter((proof) => proof.status === 'NOT_PROVEN').map((proof) => proof.table),
    sources: [
      'server/automation-schedules.ts: enqueueSchedule, scheduleAutomationsDue, processSchedule final TX',
      'server/026_automation_schedules.sql: scheduled_for and automation_next_at',
      'server/odoo-catalog-sync.ts: startOdooCatalogSync, processOdooCatalogSync final TX',
      'server/043_odoo_catalog_sync.sql: run/item created_at and captured_at',
      'scripts/packing-workstation-preservation.ts: exact listing observation reconstruction pattern',
    ],
    limitation: 'Only these seven tables and the current empty automation/single-page Odoo source paths are classified. Jobs/configs require their separate verifier; every other original table must remain strict. Failed exact SHA, audit cardinality or source linkage is never waived. Odoo manual and periodic starts share the same source function: run/job binding proves that source path, not exclusive human-vs-scheduler causation.',
  };
}
