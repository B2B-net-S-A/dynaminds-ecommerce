/** Lifetime stocktake caps are per plan, like the WMS lot caps (fd7f783, b42ca1f): starter/business keep
 * 2000 heads/reviews, 1M scan receipts and the 128 MiB shared scan budget; enterprise is sized from the
 * §10 scale profile (see server/stocktake-limits.ts). The checks count at most cap+1 rows.
 * The DB part runs on a PG04 clone dynaminds_stk29_20261029_NN of the restored template migrated to HEAD:
 * it plants rows/counters inside a transaction that is always rolled back and asks the real checks. */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { PoolClient } from 'pg';
import {
  STOCKTAKE_PLAN_LIMITS,
  stocktakeLimitsForPlan,
  stocktakeScanBudgetInTx,
  wmsStocktakeQuotaInTx,
} from '../server/stocktake-limits';
import { WMS_STOCKTAKE_LIMITS } from '../server/wms-stocktakes-schema';
import { STOCKTAKE_SCAN_LIMITS } from '../server/stocktake-scans-schema';
import { WMS_LOT_PLAN_LIMITS } from '../server/wms-lots-limits';

assert.equal(process.env.DYNA_TEST, 'true');
const database = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : null;
const onClone =
  database?.hostname === '127.0.0.1' &&
  database.port === '57084' &&
  /^\/dynaminds_(?:stk29|int29b|p277|m26[123])_202610(?:29|30)_[0-9]{2}$/.test(database.pathname);
const MiB = 1024 * 1024;

test('stocktake caps: starter/business keep today values, enterprise is larger, unknown plan gets the small ones', () => {
  for (const plan of ['starter', 'business', 'platinum', null, undefined, 'toString', '__proto__']) {
    const l = stocktakeLimitsForPlan(plan as string | null | undefined);
    assert.equal(l.heads, 2000, String(plan));
    assert.equal(l.reviews, 2000, String(plan));
    assert.equal(l.scan_receipts, 1_000_000, String(plan));
    assert.equal(l.scan_evidence_bytes, 128 * MiB, String(plan));
  }
  assert.equal(WMS_STOCKTAKE_LIMITS.heads, 2000);
  assert.equal(STOCKTAKE_SCAN_LIMITS.receipts_per_tenant, 1_000_000);
  const e = STOCKTAKE_PLAN_LIMITS.enterprise;
  assert(e.heads > 2000 && e.reviews >= e.heads, JSON.stringify(e));
  assert(e.scan_receipts > 1_000_000, JSON.stringify(e));
  // The scan budget is shared with the whole WMS history, so it must not refuse scans before the
  // enterprise WMS byte budget itself is exhausted.
  assert(e.scan_evidence_bytes > WMS_LOT_PLAN_LIMITS.enterprise.evidence_bytes, JSON.stringify(e));
  // A receipt is one scanned unit; the per-stocktake cap stays the same for every plan.
  assert.equal(STOCKTAKE_SCAN_LIMITS.receipts_per_stocktake, 100_000);
});

/** Fake transaction: answers the plan read and bounded counts from planted totals, recording each LIMIT. */
function fake(plan: string, planted: Record<string, number>) {
  const limits: Record<string, number> = {};
  const c = {
    async query(sql: string, params: unknown[] = []) {
      if (/SELECT plan FROM tenants/.test(sql)) return { rows: [{ plan }] };
      const m = /FROM \(SELECT 1 FROM (\w+) .*LIMIT \$(\d+)\) x/.exec(sql);
      assert(m, 'every count is bounded by a LIMIT parameter: ' + sql);
      const key = m[1] + (/stocktake_id/.test(sql) ? ':parent' : '');
      const cap = Number(params[Number(m[2]) - 1]);
      limits[key] = cap;
      return { rows: [{ n: String(Math.min(planted[key] ?? 0, cap)) }] };
    },
  } as unknown as PoolClient;
  return { c, limits };
}
const outcome = (p: Promise<unknown>) =>
  p.then(
    () => 'admitted',
    (e: any) => `${e.status} ${e.message}`,
  );

test('heads/reviews: the old 2000 stops business, not enterprise; the count reads at most cap+1 rows', async () => {
  for (const kind of ['heads', 'reviews'] as const) {
    const table = kind === 'heads' ? 'wms_stocktakes' : 'wms_stocktake_reviews';
    const business = fake('business', { [table]: 2000 });
    assert.equal(await outcome(wmsStocktakeQuotaInTx(business.c, kind)), '429 Wyczerpano budżet historii spisów');
    assert.equal(business.limits[table], 2001);
    assert.equal(await outcome(wmsStocktakeQuotaInTx(fake('business', { [table]: 1999 }).c, kind)), 'admitted');
    const enterprise = fake('enterprise', { [table]: 2000 });
    assert.equal(await outcome(wmsStocktakeQuotaInTx(enterprise.c, kind)), 'admitted');
    assert.equal(enterprise.limits[table], STOCKTAKE_PLAN_LIMITS.enterprise[kind] + 1);
    const full = fake('enterprise', { [table]: 10 ** 9 });
    assert.equal(await outcome(wmsStocktakeQuotaInTx(full.c, kind)), '429 Wyczerpano budżet historii spisów');
  }
});

after(async () => {
  if (onClone) await (await import('../server/db')).pool.end();
});

// ---- PG04 clone: real tables, RLS, 235 counters; everything planted is rolled back. ----
type Ask = (c: PoolClient, tenant: string) => Promise<void>;
async function inRolledBackTx(work: (c: PoolClient) => Promise<void>) {
  const { pool } = await import('../server/db');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL statement_timeout=0');
    await work(c);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}
/** Owner plants with triggers and FKs off; the check then runs as dyna_app in the tenant scope. */
async function asApp(c: PoolClient, tenant: string, plan: string, check: () => Promise<unknown>) {
  await c.query('RESET ROLE');
  await c.query('UPDATE tenants SET plan=$2 WHERE id=$1', [tenant, plan]);
  await c.query('SET LOCAL ROLE dyna_app');
  await c.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
  return outcome(check());
}
const hex = "repeat('a',64)";
async function cloneTenant(c: PoolClient, withCounters: boolean) {
  const r = (
    await c.query(
      `SELECT t.id,(SELECT w.id FROM warehouses w WHERE w.tenant_id=t.id ORDER BY w.id LIMIT 1) wh,
      (SELECT m.user_id FROM memberships m WHERE m.tenant_id=t.id ORDER BY m.user_id LIMIT 1) usr
      FROM tenants t WHERE EXISTS(SELECT 1 FROM warehouses w WHERE w.tenant_id=t.id)
      AND EXISTS(SELECT 1 FROM memberships m WHERE m.tenant_id=t.id)
      AND (NOT $1 OR EXISTS(SELECT 1 FROM wms_evidence_usage u WHERE u.tenant_id=t.id))
      ORDER BY t.id LIMIT 1`,
      [withCounters],
    )
  ).rows[0];
  assert(r, 'clone needs a tenant with a warehouse and a member' + (withCounters ? ' and 235 counters' : ''));
  return r as { id: string; wh: string; usr: string };
}

test('heads/reviews on the clone: 2000 planted heads and reviews stop business, not enterprise', { skip: !onClone && 'needs DATABASE_URL of a dynaminds_stk29_20261029_NN clone' }, async () => {
  await inRolledBackTx(async (c) => {
    const t = await cloneTenant(c, false);
    await c.query('SET LOCAL session_replication_role=replica');
    await c.query(
      `INSERT INTO wms_stocktakes(id,tenant_id,warehouse_id,actor_id,client_key,request_hash,request,scope_hash,policy_version,currency,name,blind,state)
      SELECT gen_random_uuid(),$1,$2,$3,gen_random_uuid(),${hex},'{}',${hex},1,'PLN','planted '||g,false,'posted'
      FROM generate_series(1,2000-(SELECT count(*) FROM wms_stocktakes WHERE tenant_id=$1)) g`,
      [t.id, t.wh, t.usr],
    );
    await c.query(
      `INSERT INTO wms_stocktake_reviews(id,tenant_id,stocktake_id,actor_id,client_key,request_hash,request,stocktake_version,scope_hash,summary)
      SELECT gen_random_uuid(),$1,s.id,$2,gen_random_uuid(),${hex},'{}',1,${hex},'{}' FROM wms_stocktakes s WHERE s.tenant_id=$1
      ORDER BY s.id LIMIT 2000-(SELECT count(*) FROM wms_stocktake_reviews WHERE tenant_id=$1)`,
      [t.id, t.usr],
    );
    await c.query('SET LOCAL session_replication_role=origin');
    for (const kind of ['heads', 'reviews'] as const) {
      assert.equal(await asApp(c, t.id, 'business', () => wmsStocktakeQuotaInTx(c, kind)), '429 Wyczerpano budżet historii spisów', kind);
      assert.equal(await asApp(c, t.id, 'starter', () => wmsStocktakeQuotaInTx(c, kind)), '429 Wyczerpano budżet historii spisów', kind);
      assert.equal(await asApp(c, t.id, 'enterprise', () => wmsStocktakeQuotaInTx(c, kind)), 'admitted', kind);
    }
  });
});

const plantReceipts = async (c: PoolClient, t: { id: string; usr: string }, n: number, stocktakes: number) => {
  await plantRows(c, t, n, stocktakes);
  // Rows planted with triggers off do not reach the 277 scan counter (when installed): add them as its trigger would.
  if ((await c.query("SELECT to_regclass('public.stocktake_scan_usage') IS NOT NULL v")).rows[0].v)
    await c.query(
      `SELECT stocktake_scan_usage_add($1,count(*),coalesce(sum(octet_length(to_jsonb(x)::text)),0)::bigint)
      FROM stocktake_scan_receipts x WHERE tenant_id=$1 AND created_at>=transaction_timestamp()`,
      [t.id],
    );
};
const plantRows = (c: PoolClient, t: { id: string; usr: string }, n: number, stocktakes: number) =>
  c.query(
    `INSERT INTO stocktake_scan_receipts(id,tenant_id,engine,quantity_stocktake_id,quantity_line_id,quantity_measurement_id,product_id,location,actor_id,source,client_key,request_hash,request,kind,generation_id,code,source_snapshot,matched_by,basis_hash,counted,before_line_version,after_line_version,stocktake_version,result,created_at)
    SELECT r.id,$1,'quantity',('00000000-0000-4000-8000-'||lpad(to_hex(g % $3),12,'0'))::uuid,gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'A-01',$2,'api',gen_random_uuid(),${hex},'{}','start',r.id,'SKU-1','{}','["sku"]',${hex},0,1,2,1,'{}',clock_timestamp()
    FROM generate_series(1,$4) g CROSS JOIN LATERAL (SELECT gen_random_uuid() id WHERE g IS NOT NULL) r`,
    [t.id, t.usr, stocktakes, n],
  );
const fresh = '00000000-0000-4000-8000-ffffffffffff';

test('scan receipts on the clone: 1 000 001 planted receipts stop business, not enterprise', { skip: !onClone && 'needs DATABASE_URL of a dynaminds_stk29_20261029_NN clone' }, async () => {
  await inRolledBackTx(async (c) => {
    const t = await cloneTenant(c, false);
    const have = Number((await c.query('SELECT count(*) n FROM stocktake_scan_receipts WHERE tenant_id=$1', [t.id])).rows[0].n);
    await c.query('SET LOCAL session_replication_role=replica');
    // 20 parents of ~50 000 receipts each: every parent stays under the per-stocktake cap of 100 000.
    await plantReceipts(c, t, 1_000_001 - have, 20);
    await c.query('SET LOCAL session_replication_role=origin');
    const ask = (plan: string) => asApp(c, t.id, plan, () => stocktakeScanBudgetInTx(c, 'quantity', fresh));
    assert.equal(await ask('business'), '429 Wyczerpano trwały limit skanów');
    assert.equal(await ask('enterprise'), 'admitted');
  });
});

test('shared scan budget on the clone: WMS history at 128 MiB plus one receipt stops business, not enterprise', { skip: !onClone && 'needs DATABASE_URL of a dynaminds_stk29_20261029_NN clone' }, async () => {
  await inRolledBackTx(async (c) => {
    const t = await cloneTenant(c, true);
    // Owner: the tenant's 235 counter holds exactly the small WMS budget (allowed by the WMS check itself).
    await c.query(
      `UPDATE wms_evidence_usage SET bytes=bytes+($2-(SELECT sum(bytes) FROM wms_evidence_usage WHERE tenant_id=$1))
      WHERE tenant_id=$1 AND slot=(SELECT min(slot) FROM wms_evidence_usage WHERE tenant_id=$1)`,
      [t.id, 128 * MiB],
    );
    await c.query('SET LOCAL session_replication_role=replica');
    await plantReceipts(c, t, 1, 1);
    await c.query('SET LOCAL session_replication_role=origin');
    const ask = (plan: string) => asApp(c, t.id, plan, () => stocktakeScanBudgetInTx(c, 'quantity', fresh));
    assert.equal(await ask('business'), '429 Wyczerpano wspólny budżet dowodów skanowania');
    assert.equal(await ask('enterprise'), 'admitted');
  });
});
