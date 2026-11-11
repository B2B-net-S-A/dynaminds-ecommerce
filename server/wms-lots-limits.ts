import type { PoolClient } from 'pg';
import { ensure } from './errors';
import { WMS_LOT_LIMITS } from './wms-lots-schema';

/** Durable caps on a tenant's undeletable WMS history (rows are append-only by wms_row_guard).
 * They bound the storage one tenant can pin forever, so they stay lifetime totals, sized per
 * service plan like the other plan quotas (service_plans/enforce_workspace_quota). */
export type WmsLotDurableLimits = Readonly<{
  operations: number;
  layers: number;
  previews: number;
  evidence_bytes: number;
}>;
const small: WmsLotDurableLimits = Object.freeze({
  operations: WMS_LOT_LIMITS.operations,
  layers: WMS_LOT_LIMITS.layers,
  previews: WMS_LOT_LIMITS.previews,
  evidence_bytes: WMS_LOT_LIMITS.evidence_bytes,
});
/** Enterprise: 10M operations is ~20 years of the stage-5 lot tenant (235k per 180 days);
 * 64 GiB matches ~6.5 KiB per operation (a scan stores the full order, ~10 KiB).
 * Previews: every correction, move and opening needs one, and one preview becomes at most one
 * operation, so enterprise gets the operations cap. The stage-5 load run used 2000 per tenant
 * in ~50 min (~40/min, docs/scale/LOAD-TEST-FULL-20261029.md §4.2); 10M is ~170 days of that
 * peak nonstop. A stored adjustment/opening preview is ~4 KiB, so the 64 GiB byte budget, which
 * counts preview bytes too, stays the storage bound. Counted by the 235 counters (O(1)). */
export const WMS_LOT_PLAN_LIMITS: Readonly<Record<string, WmsLotDurableLimits>> = Object.freeze({
  starter: small,
  business: small,
  enterprise: Object.freeze({
    operations: 10_000_000,
    layers: 10_000_000,
    previews: 10_000_000,
    evidence_bytes: 64 * 1024 * 1024 * 1024,
  }),
});
let injected: Readonly<Record<string, WmsLotDurableLimits>> | null = null;
/** Test seam: lowered caps instead of writing 100k real rows. Refused outside DYNA_TEST. */
export function injectWmsLotPlanLimitsForTest(limits: Record<string, WmsLotDurableLimits> | null) {
  if (process.env.DYNA_TEST !== 'true') throw new Error('WMS plan limits can be injected only in tests');
  injected = limits && Object.freeze({ ...limits });
}
/** Unknown or missing plan gets the small caps, never the larger ones. */
export function wmsLotLimitsForPlan(plan: string | null | undefined): WmsLotDurableLimits {
  const table = injected ?? WMS_LOT_PLAN_LIMITS;
  return (plan && Object.hasOwn(table, plan) ? table[plan] : table.starter) ?? small;
}
/** Stock rows one WMS opening may cover, per table (stock and stock_locations), zero rows
 * included: every product gets a stock row on creation. Rows without stock are locked and
 * digested in SQL, not loaded (wms-lots.ts openingSnapshot), so the cap bounds lock and digest
 * time within the 8 s statement limit. Enterprise: 100 000 SKU in two warehouses
 * (docs/parity/WMS-LIMITS-20261026.md, measured on PG04). Positive rows stay bounded by the
 * opening lines (WMS_LOT_LIMITS.physical_rows) and the request bytes for every plan. */
export const WMS_LOT_OPENING_ROWS: Readonly<Record<string, number>> = Object.freeze({
  starter: WMS_LOT_LIMITS.physical_rows,
  business: WMS_LOT_LIMITS.physical_rows,
  enterprise: 200_000,
});
/** Unknown or missing plan gets the small cap. */
export function wmsLotOpeningRowsForPlan(plan: string | null | undefined): number {
  return plan && Object.hasOwn(WMS_LOT_OPENING_ROWS, plan)
    ? WMS_LOT_OPENING_ROWS[plan]
    : WMS_LOT_LIMITS.physical_rows;
}
const scope = "nullif(current_setting('app.tenant_id',true),'')::uuid";
const planInTx = async (c: PoolClient): Promise<string | undefined> =>
  (await c.query(`SELECT plan FROM tenants WHERE id=${scope}`)).rows[0]?.plan;
/** Limits of the tenant in the transaction scope (the same scope RLS gives the counts). */
export async function wmsLotLimitsInTx(c: PoolClient) {
  return wmsLotLimitsForPlan(await planInTx(c));
}
export async function wmsLotOpeningRowsInTx(c: PoolClient) {
  return wmsLotOpeningRowsForPlan(await planInTx(c));
}

export type WmsEvidenceUsage = {
  previews: number;
  operations: number;
  layers: number;
  bytes: bigint | null;
  source: 'counter' | 'scan';
};
const evidenceTables = [
  'wms_operations',
  'wms_previews',
  'wms_lots',
  'wms_cost_layers',
  'wms_layer_movements',
  'wms_issue_fragments',
  'wms_return_fragments',
];
const stocktakeTables = [
  'wms_stocktakes',
  'wms_stocktake_lines',
  'wms_stocktake_scope_layers',
  'wms_stocktake_measurements',
  'wms_stocktake_measurement_layers',
  'wms_stocktake_reviews',
  'wms_stocktake_review_rows',
  'wms_stocktake_postings',
];
/** Usage of undeletable WMS history. With wms_evidence_usage installed (counters settled per
 * operation, docs/parity/WMS-LIMITS-20261026.md) this reads at most 32 rows plus the operations
 * of this transaction; without it, the original full count and to_jsonb scan, whose cost grows
 * with history. */
export async function wmsEvidenceUsageInTx(c: PoolClient, bytes: boolean): Promise<WmsEvidenceUsage> {
  const avail = (
    await c.query(`SELECT to_regclass('public.wms_evidence_usage') IS NOT NULL counter,
    to_regclass('public.wms_stocktakes') IS NOT NULL stocktakes`)
  ).rows[0];
  if (avail.counter) {
    // Settle this transaction's operations (and their child rows) before reading.
    if (bytes) await c.query('SELECT wms_evidence_usage_settle()');
    const r = (
      await c.query(`SELECT coalesce(sum(previews),0)::text previews,coalesce(sum(operations),0)::text operations,
      coalesce(sum(layers),0)::text layers,coalesce(sum(bytes),0)::text bytes
      FROM wms_evidence_usage WHERE tenant_id=${scope}`)
    ).rows[0];
    return {
      previews: Number(r.previews),
      operations: Number(r.operations),
      layers: Number(r.layers),
      bytes: BigInt(r.bytes),
      source: 'counter',
    };
  }
  const counts = (
    await c.query(`SELECT (SELECT count(*) FROM wms_previews)::text previews,
    (SELECT count(*) FROM wms_operations)::text operations,
    (SELECT count(*) FROM wms_cost_layers)::text layers`)
  ).rows[0];
  let total: bigint | null = null;
  if (bytes) {
    const names = avail.stocktakes ? [...evidenceTables, ...stocktakeTables] : evidenceTables;
    const q = names
      .map((name) => `SELECT coalesce(sum(octet_length(to_jsonb(t)::text)),0) n FROM ${name} t`)
      .join(' UNION ALL ');
    total = BigInt((await c.query(`SELECT sum(n)::text bytes FROM (${q}) b`)).rows[0].bytes);
  }
  return {
    previews: Number(counts.previews),
    operations: Number(counts.operations),
    layers: Number(counts.layers),
    bytes: total,
    source: 'scan',
  };
}
/** Before a write: room for one more operation/layer (and preview). */
export async function wmsLotsQuotaInTx(c: PoolClient, previews = false) {
  const limits = await wmsLotLimitsInTx(c);
  const u = await wmsEvidenceUsageInTx(c, false);
  ensure(
    u.operations < limits.operations &&
      u.layers < limits.layers &&
      (!previews || u.previews < limits.previews),
    429,
    'Wyczerpano trwały limit dowodów WMS',
  );
}
/** After a write: the history including this transaction's rows fits the plan. */
export async function wmsLotsEvidenceBudgetInTx(c: PoolClient) {
  const limits = await wmsLotLimitsInTx(c);
  const u = await wmsEvidenceUsageInTx(c, true);
  ensure(
    u.previews <= limits.previews &&
      u.operations <= limits.operations &&
      u.layers <= limits.layers,
    429,
    'Wyczerpano trwały limit dowodów WMS',
  );
  ensure(
    (u.bytes ?? 0n) <= BigInt(limits.evidence_bytes),
    429,
    'Wyczerpano budżet nieusuwalnej historii WMS',
  );
}
/** Final settle before COMMIT, so child rows written after the last budget check still count. */
export async function settleWmsEvidenceUsageInTx(c: PoolClient) {
  if ((await c.query("SELECT to_regclass('public.wms_evidence_usage') IS NOT NULL counter")).rows[0].counter)
    await c.query('SELECT wms_evidence_usage_settle()');
}
