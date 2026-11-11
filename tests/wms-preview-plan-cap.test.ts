/** The lifetime WMS preview cap is per plan (docs/scale/LOAD-TEST-FULL-20261029.md §4.2): starter/business
 * keep 2000, enterprise is sized like its operations. Every stock correction and move needs a preview, so
 * a flat 2000 stopped the load-run enterprise tenants A/C/E after ~50 minutes.
 * The DB part runs on a fresh PG04 clone dynaminds_fix29b_20261029_NN of the restored template migrated to
 * HEAD (235 counters installed): it fills a real enterprise and a real starter tenant up to 2000 previews in
 * the 235 counter (rolled back) and asks the real pre-write quota. */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WMS_LOT_PLAN_LIMITS,
  wmsEvidenceUsageInTx,
  wmsLotLimitsForPlan,
  wmsLotsQuotaInTx,
} from '../server/wms-lots-limits';
import { WMS_LOT_LIMITS } from '../server/wms-lots-schema';

assert.equal(process.env.DYNA_TEST, 'true');
const database = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : null;
const onClone =
  database?.hostname === '127.0.0.1' &&
  database.port === '57084' &&
  /^\/dynaminds_(?:fix29b|int29b)_20261029_[0-9]{2}$/.test(database.pathname);

test('preview cap: starter/business keep 2000, enterprise is sized like its operations', () => {
  assert.equal(WMS_LOT_LIMITS.previews, 2000);
  assert.equal(wmsLotLimitsForPlan('starter').previews, 2000);
  assert.equal(wmsLotLimitsForPlan('business').previews, 2000);
  const e = WMS_LOT_PLAN_LIMITS.enterprise;
  // One preview per correction/move; the 30+30 min load run used 2000 per tenant (§4.2).
  assert(e.previews >= 1_000_000, `enterprise previews ${e.previews}`);
  assert(e.previews <= e.operations, 'a preview is consumed by at most one operation');
  // The byte budget stays the storage bound: the cap at ~4 KiB per stored preview fits in it.
  assert(BigInt(e.previews) * 4096n < BigInt(e.evidence_bytes));
  assert.equal(wmsLotLimitsForPlan('platinum').previews, 2000);
  assert.equal(wmsLotLimitsForPlan(null).previews, 2000);
});

test('preview cap on the clone: 2000 previews stop starter, not enterprise; the check reads the counter', { skip: !onClone && 'needs DATABASE_URL of a dynaminds_fix29b_20261029_NN clone' }, async () => {
  const { pool } = await import('../server/db');
  const tenant = async (plan: string) =>
    (
      await pool.query(
        `SELECT u.tenant_id id FROM wms_evidence_usage u JOIN tenants t ON t.id=u.tenant_id
        WHERE t.plan=$1 GROUP BY 1 ORDER BY 1 LIMIT 1`,
        [plan],
      )
    ).rows[0]?.id as string;
  const ask = async (plan: string) => {
    const id = await tenant(plan);
    assert(id, `clone needs a ${plan} tenant with WMS evidence counters`);
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      // Owner: bring the tenant's preview counter to exactly the small cap (rolled back below).
      await c.query(
        `UPDATE wms_evidence_usage SET previews=previews+(2000-(SELECT sum(previews) FROM wms_evidence_usage WHERE tenant_id=$1))
        WHERE tenant_id=$1 AND slot=(SELECT min(slot) FROM wms_evidence_usage WHERE tenant_id=$1)`,
        [id],
      );
      await c.query('SET LOCAL ROLE dyna_app');
      await c.query("SELECT set_config('app.tenant_id',$1,true)", [id]);
      const usage = await wmsEvidenceUsageInTx(c, false);
      assert.equal(usage.source, 'counter');
      assert.equal(usage.previews, 2000);
      return await wmsLotsQuotaInTx(c, true).then(
        () => 'admitted',
        (e: any) => `${e.status} ${e.message}`,
      );
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  };
  assert.equal(await ask('starter'), '429 Wyczerpano trwały limit dowodów WMS');
  assert.equal(await ask('enterprise'), 'admitted');
});

after(async () => {
  if (onClone) await (await import('../server/db')).pool.end();
});
