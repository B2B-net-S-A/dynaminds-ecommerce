/** Plan-dependent WMS history caps and the O(1) evidence budget (docs/parity/WMS-LIMITS-20261026.md).
 * Runs on a fresh PG04 clone dynaminds_(wms|m235)_20261026_NN of the restored template (existing WMS
 * tenants and history) migrated by the release before 235 (ledger ends at 234_carriers). Mid-file
 * migrate() applies the pending 235_wms_evidence_usage, the upgrade path of a real install, so the
 * same checks run against the 234 schema (full scan) and the 235 counters. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { PoolClient } from 'pg';
import { migrate, pool, tenantTx } from '../server/db';
import { createWmsOpeningPreview, wmsRecordScanInTx } from '../server/wms-lots';
import {
  WMS_LOT_PLAN_LIMITS,
  injectWmsLotPlanLimitsForTest,
  wmsEvidenceUsageInTx,
  wmsLotLimitsForPlan,
  wmsLotsEvidenceBudgetInTx,
  type WmsLotDurableLimits,
} from '../server/wms-lots-limits';
import { relaxPoolTimeouts } from './failure-helpers';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(database.hostname, '127.0.0.1');
assert.equal(database.port, '57084');
assert.match(database.pathname, /^\/dynaminds_(?:wms|m235)_20261026_[0-9]{2}$/, 'fresh clone dynaminds_(wms|m235)_20261026_NN required');
relaxPoolTimeouts();

const evidenceTables = [
  'wms_operations', 'wms_previews', 'wms_lots', 'wms_cost_layers', 'wms_layer_movements',
  'wms_issue_fragments', 'wms_return_fragments', 'wms_stocktakes', 'wms_stocktake_lines',
  'wms_stocktake_scope_layers', 'wms_stocktake_measurements', 'wms_stocktake_measurement_layers',
  'wms_stocktake_reviews', 'wms_stocktake_review_rows', 'wms_stocktake_postings',
];
const lowered = (operations: number): WmsLotDurableLimits => ({
  operations,
  layers: 1_000_000,
  previews: 1_000_000,
  evidence_bytes: 1024 * 1024 * 1024,
});
type Tenant = { id: string; admin: string; order: string; ops: number };
let enterprise: Tenant, perf: Tenant;
const setPlan = (t: Tenant, plan: string) => pool.query('UPDATE tenants SET plan=$2 WHERE id=$1', [t.id, plan]);

async function wmsTenant(plan: string, skip: string[] = []): Promise<Tenant> {
  const r = (
    await pool.query(
      `SELECT o.tenant_id id,(SELECT user_id FROM memberships m WHERE m.tenant_id=o.tenant_id AND role='admin' LIMIT 1) admin,
      coalesce((array_agg(o.order_id) FILTER(WHERE o.kind='scan'))[1],
        (SELECT id FROM orders WHERE tenant_id=o.tenant_id ORDER BY id LIMIT 1)) "order",count(*)::int ops,
      count(*) FILTER(WHERE o.kind='scan') scans
      FROM wms_operations o JOIN tenants t ON t.id=o.tenant_id JOIN wms_policies p ON p.tenant_id=o.tenant_id
      WHERE t.plan=$1 AND p.enabled AND NOT o.tenant_id=ANY($2::uuid[]) GROUP BY 1
      ORDER BY scans DESC,1 LIMIT 1`,
      [plan, skip],
    )
  ).rows[0];
  assert(r?.admin && r.order, `clone needs a ${plan} tenant with WMS history`);
  return r;
}
/** A real scan record through tenantTx (quota before, budget after, final settle). */
const scan = (t: Tenant) =>
  tenantTx(t.id, (c) =>
    wmsRecordScanInTx(
      c,
      { tenantId: t.id, userId: t.admin, role: 'admin' },
      { order_id: t.order, client_key: randomUUID(), code: 'LIMITS-TEST' },
      { test: 'wms-limits', at: new Date().toISOString() },
    ),
  );
async function asTenant<T>(tenant: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
    return await fn(c);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}
async function fullScan(tenant: string) {
  const sums = evidenceTables
    .map((t) => `SELECT coalesce(sum(octet_length(to_jsonb(x)::text)),0) n FROM ${t} x WHERE tenant_id=$1`)
    .join(' UNION ALL ');
  const r = (
    await pool.query(
      `SELECT (SELECT sum(n) FROM (${sums}) s)::text bytes,
      (SELECT count(*) FROM wms_operations WHERE tenant_id=$1)::int operations,
      (SELECT count(*) FROM wms_cost_layers WHERE tenant_id=$1)::int layers,
      (SELECT count(*) FROM wms_previews WHERE tenant_id=$1)::int previews`,
      [tenant],
    )
  ).rows[0];
  return { bytes: BigInt(r.bytes), operations: r.operations, layers: r.layers, previews: r.previews };
}
/** History of the perf tenant: copies of its own scan row (about 10 KiB, the full order). Seeded
 * as the owner with triggers off; under 235 the copies are settled like the backfill. */
async function seedHistory(t: Tenant, total: number) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL session_replication_role=replica');
    const have = Number((await c.query('SELECT count(*) n FROM wms_operations WHERE tenant_id=$1', [t.id])).rows[0].n);
    const ids = (
      await c.query(
        `INSERT INTO wms_operations(id,tenant_id,actor_id,client_key,request_hash,kind,source,policy_version,order_id,request,result,created_at)
        SELECT gen_random_uuid(),tenant_id,actor_id,gen_random_uuid(),request_hash,kind,source,policy_version,order_id,request,result,created_at
        FROM (SELECT * FROM wms_operations WHERE tenant_id=$1 AND kind='scan' ORDER BY id LIMIT 1) s,generate_series(1,$2) RETURNING id`,
        [t.id, Math.max(total - have, 0)],
      )
    ).rows.map((r) => r.id);
    if (ids.length && (await c.query("SELECT to_regclass('public.wms_evidence_settled') IS NOT NULL x")).rows[0].x) {
      await c.query(
        `WITH s AS (INSERT INTO wms_evidence_settled(tenant_id,operation_id,layers,bytes)
        SELECT tenant_id,id,0,octet_length(to_jsonb(o)::text) FROM wms_operations o WHERE tenant_id=$1 AND id=ANY($2::uuid[]) RETURNING bytes)
        UPDATE wms_evidence_usage SET operations=operations+(SELECT count(*) FROM s),bytes=bytes+(SELECT sum(bytes) FROM s)
        WHERE tenant_id=$1 AND slot=0`,
        [t.id, ids],
      );
    }
    await c.query('COMMIT');
    await pool.query('ANALYZE wms_operations');
  } finally {
    c.release();
  }
}
/** Median wall time of the per-operation evidence check as the app role. */
async function budgetMs(t: Tenant) {
  const runs: number[] = [];
  for (let i = 0; i < 9; i++)
    runs.push(
      await asTenant(t.id, async (c) => {
        const start = performance.now();
        await wmsLotsEvidenceBudgetInTx(c);
        return performance.now() - start;
      }),
    );
  return runs.sort((a, b) => a - b)[4];
}
/** The doc's SQL block, which must be the registered migration text byte for byte. */
function docSql() {
  const doc = readFileSync(new URL('../docs/parity/WMS-LIMITS-20261026.md', import.meta.url), 'utf8');
  const m = /```sql wms-evidence-usage235\n([\s\S]*?)```/.exec(doc);
  assert(m, 'doc carries the 235 SQL block');
  return m[1];
}
const guards = ['ordinary187_valid', 'buyer_address_guards', 'order_merge_delivery209_valid', 'return_credit206_guards',
  'ordinary188_structure_valid', 'return_credit211_metadata_valid', 'large_import173_valid', 'fa3_draft_guards',
  'pim_dictionary_valid', 'local_invoice_guards'];
const ledger = async () => (await pool.query('SELECT name FROM migrations ORDER BY name')).rows.map((r) => r.name);
const results: Record<string, unknown> = {};

before(async () => {
  assert.equal(
    (await pool.query("SELECT to_regclass('public.wms_evidence_usage') IS NULL fresh")).rows[0].fresh,
    true,
    'fresh clone without the counters required',
  );
  const names = await ledger();
  assert.equal(names.at(-1), '234_carriers', 'clone migrated by the release before 235 required');
  enterprise = await wmsTenant('enterprise');
  perf = await wmsTenant('enterprise', [enterprise.id]);
});
after(async () => {
  injectWmsLotPlanLimitsForTest(null);
  console.log('wms-limits-results', JSON.stringify(results));
  await pool.end();
});

test('plan table: enterprise is far above the small plans, unknown plans get the small caps', () => {
  const e = WMS_LOT_PLAN_LIMITS.enterprise;
  assert(e.operations >= 1_000_000 && e.layers >= 1_000_000);
  assert(e.evidence_bytes > WMS_LOT_PLAN_LIMITS.business.evidence_bytes);
  assert.deepEqual(wmsLotLimitsForPlan('starter'), wmsLotLimitsForPlan('business'));
  assert.equal(wmsLotLimitsForPlan('starter').operations, 100000);
  assert.equal(wmsLotLimitsForPlan('starter').evidence_bytes, 128 * 1024 * 1024);
  assert.deepEqual(wmsLotLimitsForPlan('platinum'), wmsLotLimitsForPlan('starter'));
  assert.deepEqual(wmsLotLimitsForPlan(null), wmsLotLimitsForPlan('starter'));
  assert.deepEqual(wmsLotLimitsForPlan('__proto__'), wmsLotLimitsForPlan('starter'));
});

async function planCapsHold(mode: string) {
  // Lowered caps: the small plans stop below the history the tenant already has. The same
  // tenant and history is refused on the business plan and continues on enterprise.
  const ops = (await fullScan(enterprise.id)).operations;
  const cap = ops - 5;
  assert(cap >= 1);
  injectWmsLotPlanLimitsForTest({ starter: lowered(cap), business: lowered(cap), enterprise: lowered(ops + 50) });
  try {
    await setPlan(enterprise, 'business');
    try {
      await assert.rejects(scan(enterprise), (e: any) => e.status === 429 && /trwały limit/.test(e.message));
    } finally {
      await setPlan(enterprise, 'enterprise');
    }
    assert.equal((await fullScan(enterprise.id)).operations, ops);
    const r = await scan(enterprise);
    assert.equal(r?.reused, false);
    assert.equal((await fullScan(enterprise.id)).operations, ops + 1);
    // The same history is refused once the enterprise cap is reached.
    injectWmsLotPlanLimitsForTest({ starter: lowered(cap), business: lowered(cap), enterprise: lowered(ops + 1) });
    await assert.rejects(scan(enterprise), (e: any) => e.status === 429);
    assert.equal((await fullScan(enterprise.id)).operations, ops + 1);
  } finally {
    injectWmsLotPlanLimitsForTest(null);
  }
  results[mode + '_cap'] = { small_cap: cap, enterprise_ops_after: ops + 1 };
}

test('current schema: an enterprise tenant past the small-plan cap keeps writing; on business it is stopped', () =>
  planCapsHold('scan'));

test('current schema: the per-operation check grows with history (the cost being fixed)', async () => {
  await seedHistory(perf, 1000);
  const small = await budgetMs(perf);
  await seedHistory(perf, 4000);
  const large = await budgetMs(perf);
  results.scan = { ops_1000_ms: +small.toFixed(2), ops_4000_ms: +large.toFixed(2) };
  assert(large > small * 2, `full scan should grow with history: ${small} -> ${large} ms`);
});

test('235: migrate() applies it on the 234 clone, all ten guards stay true and the backfill equals the full scan', async () => {
  const before = await ledger();
  const start = performance.now();
  await migrate();
  results.migrate_ms = +(performance.now() - start).toFixed(0);
  assert.deepEqual(await ledger(), [...before, '235_wms_evidence_usage'], 'migrate() applies exactly 235');
  assert.equal(docSql(), readFileSync(new URL('../server/235_wms_evidence_usage.sql', import.meta.url), 'utf8'));
  for (const guard of guards)
    assert.equal((await pool.query(`SELECT public.${guard}() v`)).rows[0].v, true, guard);
  for (const t of [enterprise, perf]) {
    const u = await asTenant(t.id, (c) => wmsEvidenceUsageInTx(c, true));
    const f = await fullScan(t.id);
    assert.equal(u.source, 'counter');
    assert.deepEqual([u.operations, u.layers, u.previews, u.bytes], [f.operations, f.layers, f.previews, f.bytes]);
  }
});

test('235: plan caps hold through the counters', () => planCapsHold('counter'));

test('235: real writes keep the counters equal to the full scan, re-settling never double counts', async () => {
  await tenantTx(enterprise.id, async (c) => {
    const a = { tenantId: enterprise.id, userId: enterprise.admin, role: 'admin' as const };
    for (let i = 0; i < 2; i++)
      await wmsRecordScanInTx(c, a, { order_id: enterprise.order, client_key: randomUUID(), code: 'LIMITS-TEST' }, { i });
    await wmsLotsEvidenceBudgetInTx(c);
    await wmsLotsEvidenceBudgetInTx(c);
  });
  await scan(enterprise);
  const u = await asTenant(enterprise.id, (c) => wmsEvidenceUsageInTx(c, true));
  const f = await fullScan(enterprise.id);
  assert.deepEqual([u.operations, u.layers, u.previews, u.bytes], [f.operations, f.layers, f.previews, f.bytes]);
  // A refused write rolls back with its counters.
  injectWmsLotPlanLimitsForTest({ starter: lowered(1), business: lowered(1), enterprise: { ...lowered(f.operations + 10), evidence_bytes: Number(f.bytes) } });
  try {
    await assert.rejects(scan(enterprise), (e: any) => e.status === 429 && /budżet/.test(e.message));
  } finally {
    injectWmsLotPlanLimitsForTest(null);
  }
  const back = await asTenant(enterprise.id, (c) => wmsEvidenceUsageInTx(c, true));
  assert.deepEqual([back.operations, back.bytes], [f.operations, f.bytes]);
  assert.equal((await fullScan(enterprise.id)).operations, f.operations);
});

test('235: writes to the ten trigger-tracked tables work and count (opening preview through the app)', async () => {
  // Statement triggers fire even for zero rows, so this reaches every INSERT/UPDATE trigger of 235.
  const c = await pool.connect();
  try {
    for (const t of evidenceTables.slice(7).concat(['wms_previews', 'wms_lots'])) {
      await c.query('BEGIN');
      try {
        await c.query(`INSERT INTO ${t} SELECT * FROM ${t} LIMIT 0`);
        if (t === 'wms_stocktakes' || t === 'wms_stocktake_lines') await c.query(`UPDATE ${t} SET id=id WHERE false`);
      } finally {
        await c.query('ROLLBACK');
      }
    }
  } finally {
    c.release();
  }
  const version = (await pool.query('SELECT version::text v FROM wms_policies WHERE tenant_id=$1', [enterprise.id])).rows[0].v;
  const before = await fullScan(enterprise.id);
  const r = await createWmsOpeningPreview(
    { tenantId: enterprise.id, userId: enterprise.admin, role: 'admin' },
    { client_key: randomUUID(), policy_version: version, currency: 'PLN', note: 'limits-test', lines: [] },
  );
  assert.equal(r.reused, false);
  const f = await fullScan(enterprise.id);
  assert.equal(f.previews, before.previews + 1);
  const u = await asTenant(enterprise.id, (c) => wmsEvidenceUsageInTx(c, true));
  assert.deepEqual([u.operations, u.layers, u.previews, u.bytes], [f.operations, f.layers, f.previews, f.bytes]);
});

test('235: the per-operation check does not grow with history', async () => {
  const small = await budgetMs(perf);
  await seedHistory(perf, 8000);
  const large = await budgetMs(perf);
  const u = await asTenant(perf.id, (c) => wmsEvidenceUsageInTx(c, true));
  assert.deepEqual([u.operations, u.bytes], [(await fullScan(perf.id)).operations, (await fullScan(perf.id)).bytes]);
  results.counter = { ops_4000_ms: +small.toFixed(2), ops_8000_ms: +large.toFixed(2) };
  assert(large < small * 1.5 + 2, `counter check should be flat: ${small} -> ${large} ms`);
  assert(large < 25, `counter check should stay a few ms: ${large} ms`);
});
