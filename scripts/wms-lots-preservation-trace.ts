/** Read-only QA111 preservation gate. Uses the caller's repeatable-read transaction. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import type { PoolClient } from 'pg';

type Fingerprint = { count: number; sha256: string };
export type WmsTraceBaseline = {
  stage: number; captured_at: string; baseline_rebased: boolean; firms: string[];
  before: Record<string, Fingerprint>;
};
type ClockOverride = {
  config_id: string; tenant_id: string; last_run_at: string; next_run_at: string;
  last_job_id: string; error: null;
};
const baselinePath = 'data/wms-lots-stage111-baseline.json';
const clockPath = 'data/wms-lots-config-trace-clocks.json';
const reportPath = 'docs/wms-lots-config-trace-qa.json';
const sha = (raw: string) => createHash('sha256').update(raw).digest('hex');
const fingerprint = (rows: unknown[]): Fingerprint => ({ count: rows.length, sha256: sha(JSON.stringify(rows)) });
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
// Same recursive object-key canonicalization as imports.importSourceHash.
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key,canonical(value[key])])) : value;
const sourceHash = (value: unknown) => sha(JSON.stringify(canonical(value)));

/** Reconstruct only the exact three enrichments in automation-schedules.freeze.
 * Plain SELECTs are deliberate: this evidence transaction is READ ONLY.
 * No arbitrary field stripping or execution of configured actions is permitted.
 */
async function frozenScheduleDefinition(c: PoolClient, tenant: string, definition: any, capture: string) {
  if (!definition || typeof definition!=='object' || !Array.isArray(definition.actions)
    || definition.actions.length<1 || definition.actions.length>5) return null;
  const actions = [];
  for (const raw of definition.actions) {
    if (!raw || typeof raw!=='object' || typeof raw.type!=='string') return null;
    if (raw.type==='set_workflow') {
      if (typeof raw.status_id!=='string' || !uuid.test(raw.status_id)) return null;
      const status = (await c.query(`SELECT version,active FROM workflow_statuses
        WHERE tenant_id=$1 AND id=$2 AND created_at<=$3::timestamptz`,
        [tenant,raw.status_id,capture])).rows[0];
      if (!status?.active || (raw.status_version && raw.status_version!==status.version)) return null;
      actions.push({...raw,status_version:status.version});
      continue;
    }
    if (raw.type!=='sms' && raw.type!=='email') { actions.push(raw); continue; }
    if (typeof raw.template_id!=='string' || !uuid.test(raw.template_id)) return null;
    const table = raw.type==='sms'?'sms_templates':'email_templates';
    const template = (await c.query(`SELECT version,active FROM ${table}
      WHERE tenant_id=$1 AND id=$2 AND created_at<=$3::timestamptz`,
      [tenant,raw.template_id,capture])).rows[0];
    if (!template?.active || (raw.template_version && raw.template_version!==template.version)) return null;
    const frozen = {...raw,template_version:raw.template_version??template.version};
    if ((raw.type==='sms' && raw.mode==='provider_test') || (raw.type==='email' && raw.mode==='smtp')) {
      if (typeof raw.channel_id!=='string' || !uuid.test(raw.channel_id)) return null;
      const ch = (await c.query(`SELECT * FROM channels WHERE tenant_id=$1 AND id=$2
        AND created_at<=$3::timestamptz`,[tenant,raw.channel_id,capture])).rows[0];
      if (!ch || (raw.type==='sms'
        ? ch.provider!=='smsapi' || ch.mode!=='sandbox' || ch.settings.simulation
        : ch.provider!=='smtp' || (ch.settings.delivery==='external' && !raw.confirm_external))) return null;
      const identity = {provider:ch.provider,mode:ch.mode,settings:ch.settings,credentials:ch.credentials};
      const channelHash = raw.type==='sms'?sha(JSON.stringify(identity)):sourceHash(identity);
      if (raw.channel_hash && raw.channel_hash!==channelHash) return null;
      frozen.channel_hash=raw.channel_hash??channelHash;
    }
    actions.push(frozen);
  }
  return {...definition,actions};
}

async function classifyAppendedJobs(c: PoolClient, baseline: WmsTraceBaseline) {
  const args = [baseline.firms,baseline.captured_at];
  const appended = (await c.query(`SELECT id,kind,state,attempts,error,locked_at,lease_token
    FROM jobs WHERE tenant_id=ANY($1::uuid[]) AND created_at>$2::timestamptz ORDER BY id`,args)).rows;
  const classified = new Map<string,{kind:string;provenance:string}>();
  const productRows = (await c.query(`SELECT to_jsonb(t) row FROM products t
    WHERE tenant_id=ANY($1::uuid[]) ORDER BY 1`,[baseline.firms])).rows;
  const products = fingerprint(productRows), originalProducts = baseline.before.products;
  const productsExact = !!originalProducts && products.count===originalProducts.count
    && products.sha256===originalProducts.sha256;
  // Empty status scans never enter per-order preview/provider/write paths.
  const status = (await c.query(`SELECT j.id,cfg.connection_hash,to_jsonb(ch) channel
    FROM jobs j JOIN order_status_configs cfg ON cfg.tenant_id=j.tenant_id
      AND cfg.channel_id::text=j.payload->>'channel_id'
    JOIN channels ch ON (ch.tenant_id,ch.id)=(cfg.tenant_id,cfg.channel_id)
    WHERE j.tenant_id=ANY($1::uuid[]) AND j.created_at>$2::timestamptz
      AND j.kind='order.status.scan' AND cfg.enabled AND NOT cfg.external_authorized
      AND ch.created_at<=$2::timestamptz
      AND ch.settings->'simulation'='true'::jsonb
      AND ch.provider IN('woocommerce','allegro','prestashop')
      AND j.payload=jsonb_build_object('channel_id',cfg.channel_id,'actor_id',cfg.actor_id,
        'version',cfg.version,'after',NULL,'stats',jsonb_build_object(
          'checked',0,'queued',0,'skipped',0,'errors',0))
      AND j.dedup_key='order.status.scan:'||j.id::text`,args)).rows;
  for (const row of status) {
    const ch = row.channel;
    // offer-sync-policy.connectionHash then order-status.statusConnection;
    // Allegro intentionally excludes encrypted credentials from this identity.
    const connection = sha(JSON.stringify({provider:ch.provider,mode:ch.mode,settings:ch.settings}));
    if (row.connection_hash === sha(JSON.stringify([connection,ch.provider==='allegro'?null:ch.credentials])))
      classified.set(row.id,{kind:'order.status.scan',provenance:'exact_config_version_local_simulation_empty_scan'});
  }

  // This is the existing demo branch in processOdooCatalogSync, not an ERP call.
  const demoContext = {currency:'PLN',currency_id:1,prices_include_tax:false,company_id:1,
    warehouse_id:1,unit_id:1,company_name:'Firma demonstracyjna Odoo',
    warehouse_name:'Magazyn ERP — przykład',unit_name:'szt.'};
  const odoo = (await c.query(`SELECT j.id,r.input_hash,r.schedule_version,r.connection_hash,
      to_jsonb(ch) channel
    FROM jobs j JOIN odoo_catalog_sync_runs r ON (r.tenant_id,r.job_id)=(j.tenant_id,j.id)
    JOIN odoo_catalog_schedules cfg ON (cfg.tenant_id,cfg.channel_id)=(r.tenant_id,r.channel_id)
    JOIN channels ch ON (ch.tenant_id,ch.id)=(r.tenant_id,r.channel_id)
    WHERE j.tenant_id=ANY($1::uuid[]) AND j.created_at>$2::timestamptz
      AND j.kind='odoo.catalog.sync' AND j.payload=jsonb_build_object('run_id',r.id)
      AND j.dedup_key='odoo-catalog:'||r.id::text AND r.created_at=j.created_at
      AND cfg.created_at<=$2::timestamptz AND ch.created_at<=$2::timestamptz
      AND ch.provider='odoo' AND ch.settings->'simulation'='true'::jsonb
      AND cfg.enabled AND cfg.prices=r.prices AND r.simulation
      AND cfg.version=r.schedule_version AND cfg.actor_id=r.actor_id
      AND cfg.connection_hash=r.connection_hash
      AND r.state='success' AND r.error IS NULL AND r.finished_at IS NOT NULL
      AND r.total>0 AND r.applied=r.total AND r.skipped=0 AND r.context=$3::jsonb
      AND r.total=(SELECT count(*) FROM odoo_catalog_sync_items i
        WHERE (i.tenant_id,i.run_id)=(r.tenant_id,r.id))
      AND NOT EXISTS(SELECT 1 FROM odoo_catalog_sync_items i
        LEFT JOIN listings l ON (l.tenant_id,l.id)=(i.tenant_id,i.listing_id)
        LEFT JOIN products p ON (p.tenant_id,p.id)=(i.tenant_id,i.product_id)
        WHERE (i.tenant_id,i.run_id)=(r.tenant_id,r.id) AND (
          i.state<>'applied' OR i.error IS NOT NULL OR i.captured_at IS NULL OR i.result IS NULL
          OR i.result->>'scope' IS DISTINCT FROM 'local_simulation'
          OR i.result->'physical_stock_changed' IS DISTINCT FROM 'false'::jsonb
          OR i.result->'local_price_before' IS DISTINCT FROM i.result->'local_price_after'
          OR i.result->'local_price_before' IS DISTINCT FROM to_jsonb(p.price)
          OR (r.prices AND i.result->'price' IS DISTINCT FROM to_jsonb(p.price))
          OR p.version IS DISTINCT FROM i.product_version OR p.vat IS DISTINCT FROM i.vat
          OR l.channel_id IS DISTINCT FROM r.channel_id OR l.product_id IS DISTINCT FROM i.product_id
          OR l.external_id IS DISTINCT FROM i.external_id
          OR i.result->>'external_id' IS DISTINCT FROM i.external_id))`,
    [...args,JSON.stringify(demoContext)])).rows;
  for (const row of odoo) {
    const ch = row.channel;
    const connection = sourceHash({provider:ch.provider,mode:ch.mode,settings:ch.settings,credentials:ch.credentials});
    if (productsExact && row.connection_hash===connection && row.input_hash===sourceHash({version:row.schedule_version}))
      classified.set(row.id,{kind:'odoo.catalog.sync',provenance:'preexisting_schedule_exact_connection_demo_catalog_no_price_or_stock_write'});
  }

  // No candidates means applyOrderAction never runs, even if its configured
  // action could otherwise send mail/SMS. Require exact frozen revision too.
  const schedules = (await c.query(`SELECT j.id,j.tenant_id,s.definition source_definition,
      r.definition frozen_definition FROM jobs j
    JOIN automation_schedule_runs r ON (r.tenant_id,r.job_id)=(j.tenant_id,j.id)
    JOIN automation_schedules s ON (s.tenant_id,s.id)=(r.tenant_id,r.schedule_id)
    WHERE j.tenant_id=ANY($1::uuid[]) AND j.created_at>$2::timestamptz
      AND j.kind='automation.schedule' AND j.payload=jsonb_build_object('run_id',r.id)
      AND j.dedup_key='automation-schedule:'||r.id::text AND r.created_at=j.created_at
      AND s.created_at<=$2::timestamptz AND s.enabled AND s.version=r.schedule_version
      AND s.definition_version=r.definition_version AND s.actor_id=r.actor_id
      AND r.scheduled_for<=r.as_of
      AND r.state='done' AND r.error IS NULL AND r.finished_at IS NOT NULL
      AND r.scanned=0 AND r.done=0 AND r.skipped=0 AND r.failed=0
      AND r.cursor_at IS NULL AND r.cursor_id IS NULL
      AND NOT EXISTS(SELECT 1 FROM automation_schedule_items i
        WHERE (i.tenant_id,i.run_id)=(r.tenant_id,r.id))
      AND NOT EXISTS(SELECT 1 FROM automation_schedule_receipts x
        WHERE (x.tenant_id,x.run_id)=(r.tenant_id,r.id))`,args)).rows;
  const sourceReferences: Record<string,{raw_exact:boolean;count:number}> = {};
  for (const name of ['channels','sms_templates','email_templates','workflow_statuses']) {
    const rows = (await c.query(`SELECT to_jsonb(t) row FROM "${name}" t
      WHERE tenant_id=ANY($1::uuid[]) ORDER BY 1`,[baseline.firms])).rows;
    const actual = fingerprint(rows), original = baseline.before[name];
    sourceReferences[name]={raw_exact:!!original && actual.count===original.count
      && actual.sha256===original.sha256,count:actual.count};
  }
  const referencesExact = Object.values(sourceReferences).every(value=>value.raw_exact);
  for (const row of schedules) {
    const frozen = await frozenScheduleDefinition(c,row.tenant_id,row.source_definition,baseline.captured_at);
    if (referencesExact && frozen && sourceHash(frozen)===sourceHash(row.frozen_definition))
      classified.set(row.id,{kind:'automation.schedule',provenance:'preexisting_exact_deterministic_freeze_revision_zero_candidates_actions_receipts'});
  }

  const requiresReview = appended.flatMap(job => {
    const expectedAttempts = job.kind==='order.status.scan'?1:0;
    const terminal = job.state==='done' && job.error===null && job.locked_at===null
      && job.lease_token===null && job.attempts===expectedAttempts;
    return classified.has(job.id) && terminal ? [] : [{job_id:job.id,kind:job.kind,
      reason:!classified.has(job.id)?'unlinked_or_unproven_source':'noncanonical_terminal_job'}];
  });
  const effects: Record<string,{raw_exact:boolean;count:number}> = {};
  for (const name of ['outbound_events','outbound_deliveries','email_messages','sms_messages']) {
    const rows = (await c.query(`SELECT to_jsonb(t) row FROM "${name}" t
      WHERE tenant_id=ANY($1::uuid[]) ORDER BY 1`,[baseline.firms])).rows;
    const actual = fingerprint(rows), original = baseline.before[name];
    effects[name] = {raw_exact:!!original && actual.count===original.count && actual.sha256===original.sha256,
      count:actual.count};
  }
  const grouped: Record<string,number> = {};
  for (const job of appended) grouped[job.kind]=(grouped[job.kind]??0)+1;
  const allClassified = requiresReview.length===0;
  const outboxExact = Object.values(effects).every(value=>value.raw_exact);
  return {status:allClassified&&outboxExact?'PROVEN_SOURCE_BOUND_LOCAL_JOBS':'REQUIRES_REVIEW',
    total:appended.length,grouped_counts:grouped,classified_count:appended.length-requiresReview.length,
    all_appended_classified:allClassified,requires_review:requiresReview,
    outbound_email_sms_raw_exact:outboxExact,outbound_tables:effects,
    products_raw_exact:productsExact,products_count:products.count,
    freeze_reference_tables_raw_exact:referencesExact,freeze_reference_tables:sourceReferences,
    provenance:[...new Set([...classified.values()].map(value=>value.provenance))],
    sources:['server/order-status-signals.ts: insertStatusScan','server/order-status.ts: processStatusScan',
      'server/odoo-catalog-sync.ts: scheduleOdooCatalogDue/processOdooCatalogSync demo branch',
      'server/odoo-catalog.ts: demoOdooContext','server/automation-schedules.ts: freeze/scheduleAutomationsDue/processSchedule',
      'server/sms-actions.ts: freezeSmsActions','server/email-actions.ts: freezeEmailActions'],
    limitation:'Current durable source bindings and exact old-tenant outbox hashes prove these local branches; this is not network capture. Caller must still verify every other table and separately explain any scheduler audit/run/listing/config drift.'};
}

/** Only these two named tables are traced. The caller must check every other table strictly. */
export async function verifyWmsLotsPreservationTrace(c: PoolClient, baseline: WmsTraceBaseline) {
  const raw = await readFile(baselinePath, 'utf8');
  assert.deepEqual(baseline, JSON.parse(raw), 'Caller baseline must equal the original saved baseline');
  assert.equal(baseline.stage, 111); assert.equal(baseline.baseline_rebased, false);
  assert.equal(baseline.firms.length, 104); assert.equal(new Set(baseline.firms).size, 104);
  assert(baseline.firms.every(id => uuid.test(id))); assert(Number.isFinite(Date.parse(baseline.captured_at)));
  const context = (await c.query(`SELECT current_setting('TimeZone') timezone,
    current_setting('transaction_isolation') isolation,current_setting('transaction_read_only') read_only`)).rows[0];
  assert.equal(context.timezone, 'UTC'); assert.equal(context.isolation, 'repeatable read');
  assert.equal(context.read_only, 'on', 'Trace must use an existing read-only transaction');
  for (const name of ['jobs','order_status_configs']) {
    const f = baseline.before[name]; assert(Number.isSafeInteger(f.count) && f.count >= 0);
    assert.match(f.sha256, /^[a-f0-9]{64}$/);
  }
  const stat = await lstat(clockPath);
  assert(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o600);
  const clockRaw = await readFile(clockPath,'utf8');
  const clocksFile = JSON.parse(clockRaw);
  assert.deepEqual(Object.keys(clocksFile), ['clock_overrides']);
  const clocks: ClockOverride[] = clocksFile.clock_overrides;
  assert(Array.isArray(clocks) && clocks.length > 0 && clocks.length <= baseline.before.order_status_configs.count);
  assert.equal(new Set(clocks.map(r => JSON.stringify([r.tenant_id,r.config_id]))).size, clocks.length);
  for (const row of clocks) {
    assert.deepEqual(Object.keys(row).sort(), ['config_id','tenant_id','last_run_at','next_run_at','last_job_id','error'].sort());
    assert(uuid.test(row.config_id) && uuid.test(row.tenant_id) && uuid.test(row.last_job_id));
    assert(baseline.firms.includes(row.tenant_id)); assert.equal(row.error,null);
    for (const value of [row.last_run_at,row.next_run_at])
      assert(typeof value === 'string' && value.length <= 50 && Number.isFinite(Date.parse(value)));
  }
  const proven = JSON.parse(await readFile(reportPath,'utf8'));
  assert.equal(proven.stage,111); assert.equal(proven.status,'PROVEN_EXACT_CLOCK_RECONSTRUCTION');
  assert.equal(proven.baseline_rebased,false); assert.equal(proven.baseline_capture,baseline.captured_at);
  assert.equal(proven.baseline_config_sha256,baseline.before.order_status_configs.sha256);
  assert.equal(proven.reconstructed_config_sha256,baseline.before.order_status_configs.sha256);
  assert.equal(proven.counts.clock_overrides,clocks.length);
  assert.equal(proven.counts.retained_jobs,baseline.before.jobs.count);
  for (const check of ['retained_before_capture_jobs_raw_exact','config_count_exact',
    'reconstructed_config_raw_sha_exact','all_enabled_configs_have_exact_version_done_job',
    'disabled_configs_unchanged_in_reconstruction']) assert.equal(proven.checks[check],true);

  const priorJobs = (await c.query(`SELECT to_jsonb(t) row FROM jobs t
    WHERE tenant_id=ANY($1::uuid[]) AND created_at<=$2::timestamptz ORDER BY 1`,
    [baseline.firms,baseline.captured_at])).rows;
  const oldJobs = fingerprint(priorJobs);
  assert.deepEqual(oldJobs,baseline.before.jobs,'Original pre-capture jobs must remain fully exact');

  // JSON timestamps are built and ordered in PostgreSQL, preserving microseconds.
  // JavaScript never parses a clock into Date or sorts complete config rows.
  const reconstructed = await c.query(`WITH overrides AS (
    SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(config_id uuid,tenant_id uuid,
      last_run_at timestamptz,next_run_at timestamptz,last_job_id uuid,error text)
  ), original_configs AS (
    SELECT cfg.* FROM order_status_configs cfg WHERE cfg.tenant_id=ANY($2::uuid[])
  ) SELECT CASE WHEN x.config_id IS NULL THEN to_jsonb(cfg) ELSE to_jsonb(cfg)||jsonb_build_object(
      'last_run_at',x.last_run_at,'next_run_at',x.next_run_at,'last_job_id',x.last_job_id,'error',x.error)
    END AS row
    FROM original_configs cfg LEFT JOIN overrides x
      ON (x.tenant_id,x.config_id)=(cfg.tenant_id,cfg.channel_id) ORDER BY 1`,
    [JSON.stringify(clocks),baseline.firms]);
  const oldConfigs = fingerprint(reconstructed.rows);
  assert.deepEqual(oldConfigs,baseline.before.order_status_configs,
    'Only four documented clocks may differ; the complete original config count/SHA must match');

  const bindings = (await c.query(`WITH overrides AS (
    SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(config_id uuid,tenant_id uuid,
      last_run_at timestamptz,next_run_at timestamptz,last_job_id uuid,error text)
  ) SELECT x.config_id FROM overrides x JOIN order_status_configs cfg
      ON (cfg.tenant_id,cfg.channel_id)=(x.tenant_id,x.config_id)
    JOIN jobs j ON (j.tenant_id,j.id)=(x.tenant_id,x.last_job_id)
    WHERE cfg.enabled AND j.kind='order.status.scan' AND j.state='done'
      AND j.created_at<=$2::timestamptz AND j.run_at<=$2::timestamptz
      AND j.payload->>'channel_id'=cfg.channel_id::text AND j.payload->>'version'=cfg.version::text
      AND x.last_run_at=j.run_at AND x.next_run_at=j.created_at+interval '60 seconds'
      AND x.error IS NULL`, [JSON.stringify(clocks),baseline.captured_at])).rows;
  assert.equal(bindings.length,clocks.length,'Every stored clock must retain its exact pre-capture source job');
  const appendedJobs = await classifyAppendedJobs(c,baseline);
  return {
    stage:111,status:appendedJobs.status==='PROVEN_SOURCE_BOUND_LOCAL_JOBS'
      ?'PROVEN_EXACT_CLOCK_RECONSTRUCTION':'REQUIRES_REVIEW',baseline_rebased:false,
    original_baseline_sha256:sha(raw),clock_evidence_sha256:sha(clockRaw),
    retained_before_capture_jobs_raw_exact:true,retained_jobs:oldJobs.count,original_jobs_sha256:oldJobs.sha256,
    config_count_exact:true,original_configs:oldConfigs.count,original_config_sha256:oldConfigs.sha256,
    reconstructed_config_sha256:oldConfigs.sha256,clock_overrides:clocks.length,
    clock_fields:['last_run_at','next_run_at','last_job_id','error'],
    all_other_config_fields_raw_exact:true,all_clock_sources_bound_to_original_jobs:true,
    appended_original_tenant_jobs:appendedJobs,
    traced_tables:['jobs','order_status_configs'],untraced_tables_allowed:0,
    limitation:'Caller must strictly verify every other original table. Classified appended jobs do not waive audit/run/listing/config preservation checks.',
  };
}
