/** File-only required-workload validation. Never starts a runner or grants acceptance. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const canonicalConfig = value => JSON.stringify(value, function (key, item) {
  return item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(k => [k, item[k]])) : item;
});
const sum = values => values.reduce((total, value) => total + value, 0);
const positive = value => Number.isSafeInteger(value) && value > 0;
const percent = values => values.length > 0 && values.every(positive) && sum(values) === 100;
const slots = ['A', 'B', 'C', 'D', 'E'];

export function validateAcceptanceProfile(bytes, pointer) {
  try {
    assert(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 65536, 'PROFILE_BYTES');
    const p = JSON.parse(bytes.toString('utf8')), c = p.config;
    assert.equal(p.schema, 'dynaminds-full-base-scale-profile/v1', 'PROFILE_SCHEMA');
    assert.equal(p.version, 1, 'PROFILE_VERSION'); assert.equal(p.parent, null, 'PROFILE_PARENT');
    for (const doc of [p, pointer]) {
      assert.equal(doc.status, 'frozen_required_specification_unmeasured', 'SPEC_ONLY');
      assert.equal(doc.measurement_performed, false, 'SPEC_ONLY');
      assert.equal(doc.acceptance_granted, false, 'SPEC_ONLY');
    }
    assert.equal(pointer.schema, 'dynaminds-full-base-scale-acceptance/v1', 'POINTER_SCHEMA');
    assert.deepEqual(pointer.evidence, [], 'SPEC_HAS_NO_RUN_EVIDENCE');
    assert.deepEqual(pointer.specification, {path:'acceptance-profile.v1.json', sha256:sha256(bytes), bytes:bytes.length}, 'VERSION_PIN');
    assert.equal(p.config_sha256, sha256(canonicalConfig(c)), 'CONFIG_DIGEST');
    assert.equal(pointer.config_sha256, p.config_sha256, 'CONFIG_DIGEST');

    const d = c.dataset;
    assert.equal(d.active_tenants, 5, 'FIVE_ACTIVE_TENANTS');
    assert.equal(d.sku_records_total, 100000, 'DATASET_TOTAL'); assert.equal(d.orders_total, 100000, 'DATASET_TOTAL');
    assert.deepEqual(d.per_tenant.map(t => t.slot), slots, 'TENANT_DISTRIBUTION');
    assert(d.per_tenant.every(t => t.sku_records >= 20000 && t.orders >= 20000 && t.warehouses_min >= 2 && t.stock_locations_per_warehouse_min >= 20), 'TENANT_MINIMUM');
    assert.equal(sum(d.per_tenant.map(t => t.sku_records)), d.sku_records_total, 'DATASET_SUM');
    assert.equal(sum(d.per_tenant.map(t => t.orders)), d.orders_total, 'DATASET_SUM');
    assert.deepEqual(d.per_tenant.map(t => t.wms_lots), [true,false,true,false,true], 'WMS_OFF_ON');
    assert(d.history_days >= 180, 'HISTORY_BURDEN');
    for (const distribution of [d.order_status_percent,d.sku_kind_percent,d.order_line_buckets_percent,d.order_unit_buckets_percent]) assert(percent(Object.values(distribution)), 'DATASET_PERCENT');
    assert.deepEqual(pointer.minimum_dataset, {sku_records:100000, orders:100000, simultaneously_active_tenants:5, sku_records_per_tenant:20000, orders_per_tenant:20000}, 'POINTER_DATASET');

    const t = c.timing, phases = t.measurement_phases;
    assert.equal(t.measurement_seconds, 3600, 'FULL_HOUR');
    assert.equal(phases.length, 2, 'TWO_PHASES');
    assert.deepEqual(phases.map(p => p.http_clients), [12,24], 'CLIENT_LEVELS');
    assert(phases.every(p => p.duration_seconds === 1800 && p.required_peak_actual_inflight === p.http_clients && p.one_second_windows_reaching_target_min >= 60), 'ACTUAL_CONCURRENCY');
    assert.deepEqual(phases.map(p => p.success_http_rps_min), [10,20], 'THROUGHPUT');
    assert.equal(sum(phases.map(p => p.duration_seconds)), t.measurement_seconds, 'FULL_HOUR');
    assert(t.warmup_seconds === 600 && t.warmup_excluded_from_latency_and_throughput && t.recovery_excluded_from_steady_measurement, 'MEASUREMENT_BOUNDARY');
    assert(t.cold.attempts >= 3 && t.cold.sequential && t.cold.fresh_process_each_attempt && t.cold.application_cache_empty && t.cold.start_to_authenticated_business_and_worker_ready_ms_max <= 180000, 'COLD_BOUNDARY');
    assert(t.warm_restart_to_business_ready_ms_max <= 60000 && t.worker_drain_after_measurement_seconds_max <= 120, 'RESTART_BOUNDARY');
    const h = c.http;
    assert.deepEqual(h.tenant_share_percent, {A:20,B:20,C:20,D:20,E:20}, 'FIVE_ACTIVE_SHARES');
    assert(percent(h.mix.map(m => m.percent)), 'HTTP_MIX');
    assert.equal(new Set(h.mix.map(m => m.id)).size, 8, 'HTTP_OPERATIONS');
    assert.equal(sum(h.mix.filter(m => m.class === 'read').map(m => m.percent)), 60, 'READ_WRITE_MIX');
    assert.equal(sum(h.mix.filter(m => m.class === 'write').map(m => m.percent)), 40, 'READ_WRITE_MIX');
    assert(h.samples_per_tenant_per_operation_per_phase_min >= 100 && h.payload.list_page_size === 50, 'MEANINGFUL_SAMPLES');
    assert(h.client_active_fraction_per_phase_min >= 0.95 && h.client_active_fraction_per_phase_min <= 1, 'ACTIVE_CLIENTS');
    assert.deepEqual(h.timeouts_ms, {driver_request:10000,runtime_statement:8000,runtime_lock:8000,cold_approval_only:120000}, 'FINITE_TIMEOUTS');

    const b = c.background;
    assert.equal(b.required_during_both_entire_phases, true, 'BACKGROUND_REQUIRED');
    assert.deepEqual(b.tenant_slots, slots, 'BACKGROUND_TENANTS');
    assert(b.minimum_actual_worker_processors >= 2, 'ACTUAL_WORKERS');
    assert.deepEqual(b.lanes.map(l => [l.id,l.per_tenant_per_minute]), [['automation',5],['order_import',6],['stock_sync',12]], 'BACKGROUND_RATES');
    assert.equal(b.dependencies.external_live_calls_allowed, false, 'LOCAL_ONLY');
    assert.equal(b.dependencies.official_local_woo_required_for_import_and_sync, true, 'ACTUAL_LOCAL_WOO');
    assert(b.dependencies.local_official_woo_instances_min >= 2, 'ACTUAL_LOCAL_WOO');
    assert(b.queue_limits.oldest_eligible_age_p95_ms_max <= 15000 && b.queue_limits.oldest_eligible_age_max_ms <= 60000 && b.queue_limits.end_drain_seconds_max <= 120 && b.queue_limits.unresolved_unknown_at_final_reconciliation_max === 0, 'QUEUE_BUDGET');
    const l = c.limits;
    assert.deepEqual(l.latency_ms, {read_p95_max:500,read_p99_max:1000,write_p95_max:4000,write_p99_max:8000}, 'LATENCY_BUDGET');
    for (const key of ['unexpected_http_5xx_max','unexpected_timeouts_max','unexpected_errors_max','duplicate_business_effects_max','oversold_units_max','tenant_isolation_violations_max']) assert.equal(l[key], 0, 'ZERO_ERROR_BUDGET');
    assert(l.expected_contention.fraction_of_all_requests_max > 0 && l.expected_contention.fraction_of_all_requests_max <= 0.01 && l.expected_contention.reconcile_no_effect === true && l.expected_contention.excluded_from_success_throughput === true, 'EXPECTED_NOT_SUCCESS');
    assert.deepEqual(l.expected_contention.allowed_statuses, [409], 'EXPECTED_NOT_SUCCESS');
    for (const key of ['sample_interval_seconds','host_cpu_60s_mean_percent_max','app_db_workers_total_rss_bytes_max','swap_growth_bytes_max','event_loop_delay_p99_ms_max','database_pool_wait_p95_ms_max','database_pool_wait_p99_ms_max','free_disk_bytes_min','run_database_growth_bytes_max','evidence_bytes_max']) assert(positive(l.resources[key]), 'POSITIVE_RESOURCE_BUDGET');
    assert(l.resources.rss_fraction_physical_memory_max > 0 && l.resources.database_pool_utilization_p95_fraction_max > 0 && l.resources.database_pool_utilization_p95_fraction_max <= 0.8, 'RESOURCE_FRACTION');
    assert(l.resources.host_cpu_60s_mean_percent_max <= 85 && l.resources.rss_fraction_physical_memory_max <= 0.75 && l.resources.evidence_bytes_max <= 1073741824, 'RESOURCE_BUDGET');
    assert.equal(c.correctness.steady_unknown_or_unreconciled_max, 0, 'UNKNOWN_MUST_RECONCILE');
    const r = c.recovery;
    assert(r.same_release_config_and_dataset_lineage_required === true && r.faults_outside_steady_hour_only === true && r.unconfirmed_cleanup_is_failure === true, 'RECOVERY_BOUNDARY');
    assert.deepEqual(r.required_cases.map(x => x.id), ['duplicate_delivery','lost_commit_ack','lost_provider_ack','dependency_unavailable','graceful_restart','abrupt_app_exit','backup_restore'], 'RECOVERY_CASES');
    assert(r.committed_write_loss_max === 0 && r.duplicate_recovery_effects_max === 0 && r.per_case_reconciliation_deadline_seconds <= 120 && r.backup_restore_deadline_seconds <= 600, 'RECOVERY_BUDGET');
    const m = pointer.minimum_measurement;
    assert.equal(m.duration_seconds_excluding_setup_and_warmup, 3600, 'POINTER_MEASUREMENT');
    assert.deepEqual(m.mixed_HTTP_concurrency_levels, [12,24], 'POINTER_MEASUREMENT');
    assert.equal(m.duration_seconds_per_level, 1800, 'POINTER_MEASUREMENT');
    for (const key of ['background_workers_enabled','imports_active','stock_synchronization_active']) assert.equal(m[key], true, 'POINTER_BACKGROUND');
    assert(m.order_create_p95_ms_max === 4000 && m.list_and_search_p95_ms_max === 500 && m.unexpected_HTTP_500_max === 0 && m.unexpected_timeouts_max === 0 && m.oversold_units_max === 0 && m.duplicate_business_effects_max === 0, 'POINTER_BUDGET');
    assert.deepEqual(pointer.preservation, {benchmark_original_Main_database:false,send_load_to_external_provider_accounts:false,reuse_V2_workers_off_measurement_as_this_result:false,claim_Base_capacity_or_SLA:false}, 'PRESERVATION');
    return {valid:true, specification_version:1, config_sha256:p.config_sha256, measurement_performed:false, acceptance_granted:false};
  } catch (error) {
    return {valid:false, error:error instanceof assert.AssertionError ? error.message : 'MALFORMED_PROFILE', measurement_performed:false, acceptance_granted:false};
  }
}

async function main() {
  const directory = fileURLToPath(new URL('../../docs/parity/', import.meta.url));
  const [bytes, pointerBytes] = await Promise.all([fs.readFile(path.join(directory,'acceptance-profile.v1.json')), fs.readFile(path.join(directory,'acceptance-profile.json'))]);
  const result = validateAcceptanceProfile(bytes, JSON.parse(pointerBytes.toString('utf8')));
  process.stdout.write(JSON.stringify(result)+'\n');
  if (!result.valid) process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
