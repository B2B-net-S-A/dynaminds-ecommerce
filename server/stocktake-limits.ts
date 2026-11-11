import type { PoolClient } from 'pg';
import { ensure } from './errors';
import { WMS_STOCKTAKE_LIMITS } from './wms-stocktakes-schema';
import { STOCKTAKE_SCAN_LIMITS } from './stocktake-scans-schema';
import { STOCKTAKE_ADJUSTMENT_LIMITS } from './stocktake-adjustments-schema';
import { wmsEvidenceUsageInTx, wmsLotsEvidenceBudgetInTx } from './wms-lots-limits';

/** Lifetime caps on a tenant's undeletable stocktake history (heads, reviews and scan receipts are
 * append-only), sized per service plan like WMS_LOT_PLAN_LIMITS. The per-stocktake receipt cap and
 * the open-stocktake cap are not lifetime totals and stay in the schema constants. */
export type StocktakeDurableLimits = Readonly<{
  heads: number;
  reviews: number;
  scan_receipts: number;
  scan_evidence_bytes: number;
}>;
const small: StocktakeDurableLimits = Object.freeze({
  heads: WMS_STOCKTAKE_LIMITS.heads,
  reviews: WMS_STOCKTAKE_LIMITS.reviews,
  scan_receipts: STOCKTAKE_SCAN_LIMITS.receipts_per_tenant,
  scan_evidence_bytes: STOCKTAKE_SCAN_LIMITS.evidence_bytes,
});
/** Enterprise, from the §10 scale profile docs/parity/acceptance-profile.v1.json (per tenant: 20k SKU, >=2 warehouses x >=20 locations).
 * Costs measured on PG04 (docs/parity/STOCKTAKE-LIMITS-20261029.md), bounded count ~80 ns per row:
 * - heads/reviews 200 000: one active stocktake per warehouse (wms_stocktake_active); a cycle count of
 *   every location each working day is 2 x 20 x 250 = 10 000 a year, ~20 years (2000 lasts ~50 days).
 *   The count at the cap is ~10 ms, once per new head or review.
 * - scan_receipts 2 000 000: a receipt is one scanned unit; a full count of 20k SKU at ~10 units is
 *   ~200k receipts, so 10 full counts (~4 years of two full counts plus cycle counts a year). The
 *   count runs on every scan, ~190 ms at the cap, about what the old count paid for business at
 *   1M (~180 ms). A larger cap needs a usage counter instead of a count.
 * - scan_evidence_bytes 96 GiB: the budget is shared with the whole WMS history (enterprise WMS
 *   budget 64 GiB) plus 2M receipts at their 16 KiB payload maximum (32 GiB). */
export const STOCKTAKE_PLAN_LIMITS: Readonly<Record<string, StocktakeDurableLimits>> = Object.freeze({
  starter: small,
  business: small,
  enterprise: Object.freeze({
    heads: 200_000,
    reviews: 200_000,
    scan_receipts: 2_000_000,
    scan_evidence_bytes: 96 * 1024 * 1024 * 1024,
  }),
});
/** Unknown or missing plan gets the small caps, never the larger ones. */
export function stocktakeLimitsForPlan(plan: string | null | undefined): StocktakeDurableLimits {
  return plan && Object.hasOwn(STOCKTAKE_PLAN_LIMITS, plan) ? STOCKTAKE_PLAN_LIMITS[plan] : small;
}
const scope = "nullif(current_setting('app.tenant_id',true),'')::uuid";
/** Limits of the tenant in the transaction scope (the same scope RLS gives the counts). */
export async function stocktakeLimitsInTx(c: PoolClient): Promise<StocktakeDurableLimits> {
  return stocktakeLimitsForPlan((await c.query(`SELECT plan FROM tenants WHERE id=${scope}`)).rows[0]?.plan);
}
/** Exact count up to `limit` rows of the tenant (index-only on a tenant-leading index), never more. */
async function boundedCount(c: PoolClient, table: string, limit: number, where = '', params: unknown[] = []) {
  const p = params.length + 1;
  const sql = `SELECT count(*)::text n FROM (SELECT 1 FROM ${table} WHERE tenant_id=${scope}${where} LIMIT $${p}) x`;
  return Number((await c.query(sql, [...params, limit])).rows[0].n);
}

/** Before a new stocktake head or review: room for one more in the plan. */
export async function wmsStocktakeQuotaInTx(c: PoolClient, kind: 'heads' | 'reviews'): Promise<void> {
  const cap = (await stocktakeLimitsInTx(c))[kind];
  const table = kind === 'heads' ? 'wms_stocktakes' : 'wms_stocktake_reviews';
  ensure((await boundedCount(c, table, cap + 1)) < cap, 429, 'Wyczerpano budżet historii spisów');
}

/** Lifetime caps of PW/RW stocktake adjustments per plan. They are enforced in SQL by
 * stocktake_adjustment_budget() (migration 277, which keeps them in a usage counter); this table
 * documents them and a test pins the SQL literals to it. starter/business keep the 149 values.
 * Enterprise: a receipt settles one posted stocktake (UNIQUE per source), so previews/receipts scale
 * with the head cap like business does (2.5 per head: 5000 for 2000 heads, 500 000 for 200 000);
 * 16 GiB leaves 34 KiB per settlement at the cap, more than business gets (128 MiB / 5000 = 26 KiB).
 * Series (100) and series commands (5000, one per series) are configuration, not history. */
export type StocktakeAdjustmentLimits = Readonly<{
  series: number;
  series_commands: number;
  previews: number;
  receipts: number;
  evidence_bytes: number;
}>;
const smallAdjustments: StocktakeAdjustmentLimits = Object.freeze({
  series: STOCKTAKE_ADJUSTMENT_LIMITS.series,
  series_commands: 5000,
  previews: STOCKTAKE_ADJUSTMENT_LIMITS.previews,
  receipts: STOCKTAKE_ADJUSTMENT_LIMITS.receipts,
  evidence_bytes: STOCKTAKE_ADJUSTMENT_LIMITS.tenant_evidence_bytes,
});
export const STOCKTAKE_ADJUSTMENT_PLAN_LIMITS: Readonly<Record<string, StocktakeAdjustmentLimits>> = Object.freeze({
  starter: smallAdjustments,
  business: smallAdjustments,
  enterprise: Object.freeze({
    series: 100,
    series_commands: 5000,
    previews: 500_000,
    receipts: 500_000,
    evidence_bytes: 16 * 1024 * 1024 * 1024,
  }),
});

const scanTables = ['stocktake_scan_receipts', 'stocktake_measurements'];
type ScanUsage = { receipts: number; bytes: bigint };
/** Receipts and bytes of the two scan tables of the tenant from the 277 counter (at most 32 rows), or
 * null when the counter is not installed. */
async function scanUsageCounterInTx(c: PoolClient): Promise<ScanUsage | null> {
  if (!(await c.query("SELECT to_regclass('public.stocktake_scan_usage') IS NOT NULL counter")).rows[0].counter) return null;
  const r = (
    await c.query(
      `SELECT coalesce(sum(receipts),0)::text receipts,coalesce(sum(bytes),0)::text bytes FROM public.stocktake_scan_usage WHERE tenant_id=${scope}`,
    )
  ).rows[0];
  return { receipts: Number(r.receipts), bytes: BigInt(r.bytes) };
}
/** After a scan receipt is written: the tenant's receipts, this stocktake's receipts and the shared
 * WMS + scan byte budget fit the plan. The WMS part (15 tables) comes from the 235 counters and the
 * scan part from the 277 counter; without a counter, the exact scans (O(history)) as before. */
export async function stocktakeScanBudgetInTx(c: PoolClient, engine: string, stocktakeId: string): Promise<void> {
  const limits = await stocktakeLimitsInTx(c);
  const perStocktake = STOCKTAKE_SCAN_LIMITS.receipts_per_stocktake;
  const counter = await scanUsageCounterInTx(c);
  const receipts = counter
    ? counter.receipts
    : await boundedCount(c, 'stocktake_scan_receipts', limits.scan_receipts + 1);
  ensure(
    receipts <= limits.scan_receipts &&
      (await boundedCount(c, 'stocktake_scan_receipts', perStocktake + 1, ' AND engine=$1 AND stocktake_id=$2', [
        engine,
        stocktakeId,
      ])) <= perStocktake,
    429,
    'Wyczerpano trwały limit skanów',
  );
  await wmsLotsEvidenceBudgetInTx(c);
  const wms = (await wmsEvidenceUsageInTx(c, true)).bytes ?? 0n;
  const scans = counter
    ? counter.bytes
    : BigInt(
        (
          await c.query(
            `SELECT sum(n)::text bytes FROM (${scanTables
              .map((t) => `SELECT coalesce(sum(octet_length(to_jsonb(t)::text)),0) n FROM ${t} t`)
              .join(' UNION ALL ')}) x`,
          )
        ).rows[0].bytes,
      );
  ensure(
    wms + scans <= BigInt(limits.scan_evidence_bytes),
    429,
    'Wyczerpano wspólny budżet dowodów skanowania',
  );
}
