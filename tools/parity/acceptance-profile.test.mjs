import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {canonicalConfig, sha256, validateAcceptanceProfile} from './acceptance-profile.mjs';

const directory = new URL('../../docs/parity/', import.meta.url);
const originalBytes = await fs.readFile(new URL('acceptance-profile.v1.json',directory));
const originalPointer = JSON.parse(await fs.readFile(new URL('acceptance-profile.json',directory),'utf8'));
const original = JSON.parse(originalBytes);
// Re-pin each mutation: these tests must catch a genuinely invalid workload,
// rather than merely proving that editing a file changes its hash.
function mutated(change) {
  const p = structuredClone(original), pointer = structuredClone(originalPointer);
  change(p, pointer);
  p.config_sha256 = sha256(canonicalConfig(p.config)); pointer.config_sha256 = p.config_sha256;
  const bytes = Buffer.from(JSON.stringify(p)+'\n');
  pointer.specification = {path:'acceptance-profile.v1.json',sha256:sha256(bytes),bytes:bytes.length};
  return validateAcceptanceProfile(bytes,pointer);
}
function refuses(change) { assert.equal(mutated(change).valid,false); }

test('frozen profile has matching byte/config pins and remains unmeasured/unaccepted',()=>{
  assert.deepEqual(validateAcceptanceProfile(originalBytes,originalPointer), {valid:true,specification_version:1,config_sha256:original.config_sha256,measurement_performed:false,acceptance_granted:false});
});
test('one large tenant cannot conceal four small datasets, missing history or WMS OFF/ON coverage',()=>{
  refuses(p=>{p.config.dataset.per_tenant[0].orders+=19999;p.config.dataset.per_tenant[4].orders=1;});
  refuses(p=>{p.config.dataset.per_tenant.pop();});
  refuses(p=>{p.config.dataset.history_days=1;});
  refuses(p=>{p.config.dataset.per_tenant[0].wms_lots=false;});
  refuses(p=>{p.config.dataset.order_status_percent.shipped=30;});
});
test('full hour needs both half-hours and proven actual overlap rather than configured clients',()=>{
  refuses(p=>{p.config.timing.measurement_phases[1].duration_seconds=60;});
  refuses(p=>{p.config.timing.measurement_phases[1].required_peak_actual_inflight=1;});
  refuses(p=>{p.config.timing.measurement_phases[0].one_second_windows_reaching_target_min=0;});
  refuses(p=>{p.config.timing.warmup_excluded_from_latency_and_throughput=false;});
  refuses(p=>{p.config.timing.measurement_phases[1].success_http_rps_min=0;});
  refuses(p=>{p.config.http.client_active_fraction_per_phase_min=0.01;});
});
test('read-only, undersampled, timeout-relaxed or incorrectly weighted mixes refuse',()=>{
  refuses(p=>{for(const row of p.config.http.mix)row.class='read';});
  refuses(p=>{p.config.http.mix[0].percent=100;});
  refuses(p=>{p.config.http.samples_per_tenant_per_operation_per_phase_min=1;});
  refuses(p=>{p.config.http.timeouts_ms.runtime_statement=120000;});
  refuses(p=>{p.config.limits.latency_ms.read_p95_max=4000;});
  refuses(p=>{p.config.limits.resources.evidence_bytes_max=-1;});
});
test('workers-off, one-tenant lanes, zero producers and external live targets cannot qualify',()=>{
  refuses(p=>{p.config.background.required_during_both_entire_phases=false;});
  refuses(p=>{p.config.background.tenant_slots=['A'];});
  refuses(p=>{p.config.background.lanes[1].per_tenant_per_minute=0;});
  refuses(p=>{p.config.background.dependencies.external_live_calls_allowed=true;});
  refuses(p=>{p.config.background.dependencies.official_local_woo_required_for_import_and_sync=false;});
  refuses((p,pointer)=>{pointer.minimum_measurement.imports_active=false;});
  refuses((p,pointer)=>{pointer.preservation={};});
});
test('error budgets cannot forgive oversell, duplicates, unknowns or count fast refusals as successful throughput',()=>{
  for(const field of ['unexpected_http_5xx_max','unexpected_timeouts_max','unexpected_errors_max','duplicate_business_effects_max','oversold_units_max','tenant_isolation_violations_max']) refuses(p=>{p.config.limits[field]=1;});
  refuses(p=>{p.config.limits.expected_contention.excluded_from_success_throughput=false;});
  refuses(p=>{p.config.correctness.steady_unknown_or_unreconciled_max=1;});
});
test('recovery cannot omit lost ACK/restore, change release or hide unconfirmed cleanup',()=>{
  refuses(p=>{p.config.recovery.required_cases=p.config.recovery.required_cases.filter(x=>x.id!=='lost_provider_ack');});
  refuses(p=>{p.config.recovery.required_cases=p.config.recovery.required_cases.filter(x=>x.id!=='backup_restore');});
  refuses(p=>{p.config.recovery.same_release_config_and_dataset_lineage_required=false;});
  refuses(p=>{p.config.recovery.unconfirmed_cleanup_is_failure=false;});
});
test('source validation cannot turn an unrun specification into an acceptance receipt',()=>{
  refuses(p=>{p.measurement_performed=true;p.acceptance_granted=true;});
  refuses((p,pointer)=>{pointer.evidence.push({status:'PASS'});});
  const stale=structuredClone(originalPointer);stale.config_sha256='0'.repeat(64);
  assert.equal(validateAcceptanceProfile(originalBytes,stale).valid,false);
  const tampered=Buffer.from(originalBytes);tampered[tampered.length-2]=32;
  assert.equal(validateAcceptanceProfile(tampered,originalPointer).valid,false);
});
