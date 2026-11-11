/** Read-only QA125 on two already accepted local firms. Never rewrites original fixtures. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';

const phase = process.argv[2];
assert(['baseline', 'verify'].includes(phase));
const baselinePath = 'data/sales-reports-stage125.json';
const fixtures = ['data/wms-lots-stage111.json', 'data/source-fulfillment-stage124.json'];
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const bytesDigest = (v: Buffer) => createHash('sha256').update(v).digest('hex');
async function fixture(path: string) {
  const stat = await lstat(path);
  assert(stat.isFile() && !stat.isSymbolicLink() && !(stat.mode & 0o077));
  const bytes = await readFile(path);
  return { state: JSON.parse(bytes.toString()), sha256: bytesDigest(bytes) };
}
async function checkpoint(tenant: string, user: string) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TIME ZONE 'UTC'");
    const names = (
      await c.query(`SELECT table_name FROM information_schema.columns
      WHERE table_schema='public' AND column_name='tenant_id' AND table_name<>'sessions'
      UNION SELECT 'tenants' UNION SELECT 'users' ORDER BY 1`)
    ).rows;
    const result: Record<string, { count: number; sha256: string }> = {};
    for (const { table_name: table } of names) {
      assert(/^[a-z_][a-z0-9_]*$/.test(table));
      const identity = ['tenants', 'users'].includes(table) ? 'id' : 'tenant_id';
      const rows = (
        await c.query(
          `SELECT to_jsonb(t) row FROM "${table}" t
        WHERE ${identity}=$1 ORDER BY 1`,
          [table === 'users' ? user : tenant],
        )
      ).rows;
      result[table] = { count: rows.length, sha256: digest(rows) };
    }
    await c.query('COMMIT');
    return result;
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
}
async function get(s: any, path: string, csv = false) {
  const r = await fetch('http://127.0.0.1:4100/api/reports/sales' + path, {
    headers: { cookie: s.cookie, 'X-Workspace-ID': s.tenant },
    signal: AbortSignal.timeout(20000),
  });
  assert.equal(r.status, 200, `Read-only report ${path}: HTTP${r.status}`);
  return csv ? r.text() : r.json();
}

try {
  if (phase === 'baseline') {
    const firms = [];
    for (const path of fixtures) {
      const f = await fixture(path);
      firms.push({
        path,
        fixture_sha256: f.sha256,
        tenant: f.state.tenant,
        checkpoint: await checkpoint(f.state.tenant, f.state.user),
      });
    }
    await writeFile(baselinePath, JSON.stringify({ firms }, null, 2), { mode: 0o600, flag: 'wx' });
    console.log(
      JSON.stringify({
        status: 'BASELINE_PASS',
        firms: firms.length,
        tables: firms.map((f) => Object.keys(f.checkpoint).length),
        original_fixtures_rewritten: false,
      }),
    );
  } else {
    const revision = process.env.QA_EXPECTED_REVISION;
    assert(revision && /^[a-f0-9]{7,40}$/.test(revision));
    const health = (await (await fetch('http://127.0.0.1:4100/api/health')).json()) as any;
    assert.equal(health.revision, revision);
    const original = JSON.parse((await readFile(baselinePath)).toString());
    const results = [];
    for (const firm of original.firms) {
      const f = await fixture(firm.path);
      assert.equal(f.sha256, firm.fixture_sha256);
      assert.deepEqual(await checkpoint(f.state.tenant, f.state.user), firm.checkpoint);
      const query = '?from=2026-10-05&to=2026-10-06&currency=PLN';
      const summary = await get(f.state, '/summary' + query);
      const orders = await get(f.state, '/orders' + query);
      const returns = await get(f.state, '/returns' + query);
      const csv = await get(f.state, '/file' + query + '&kind=orders', true);
      assert(csv.length > 0);
      assert.equal(summary.can_read_value, true);
      assert.equal(summary.filters.time_zone, 'Europe/Warsaw');
      assert.equal(summary.sales.length, 1);
      assert.equal(summary.sales[0].orders, 1);
      assert.equal(orders.meta.total, 1);
      assert.equal(orders.data.length, 1);
      assert.equal(returns.meta.total, 1);
      const order = orders.data[0];
      const detail = await get(f.state, '/orders/' + order.id + query);
      assert.equal(detail.order.id, order.id);
      const priced = firm.path === fixtures[0];
      const expected = priced
        ? {
            total: '24000',
            goods: '24000',
            goodsNet: '19512',
            credit: '12000',
            currentNet: '9756',
            issued: '1622',
            recovered: '811',
            netCost: '811',
            margin: '8945',
            units: '2',
            missing: '0',
          }
        : {
            total: '5800',
            goods: '5400',
            goodsNet: '4390',
            credit: '1000',
            currentNet: '3577',
            issued: '0',
            recovered: '0',
            netCost: '0',
            margin: null,
            units: '4',
            missing: '4',
          };
      assert.equal(order.total_gross_minor, expected.total);
      assert.equal(order.goods_gross_minor, expected.goods);
      assert.equal(order.goods_net_minor, expected.goodsNet);
      assert.equal(order.returned_goods_gross_minor, expected.credit);
      assert.equal(order.current_goods_net_minor, expected.currentNet);
      assert.equal(order.commercial_quantity, expected.units);
      assert.equal(order.issued_known_cost_minor, expected.issued);
      assert.equal(order.restocked_known_cost_minor, expected.recovered);
      assert.equal(order.net_known_cost_minor, expected.netCost);
      assert.equal(order.margin_minor, expected.margin);
      assert.equal(order.cost_complete, priced);
      assert.equal(order.missing_issue_quantity, expected.missing);
      assert.equal(summary.cohort_current[0].margin_minor, expected.margin);
      assert.equal(summary.returns[0].total_gross_minor, expected.credit);
      assert.equal(returns.data[0].total_gross_minor, expected.credit);
      assert.equal(detail.commercial_lines.length, priced ? 1 : 3);
      assert(detail.commercial_lines.every((line: any) => line.margin_minor === null));
      assert(csv.includes(order.number));
      if (priced) {
        assert.equal(summary.costs[0].issued_known_minor, '1622');
        assert.equal(summary.costs[0].restocked_known_minor, '811');
        assert.equal(summary.costs[0].issued_quantity, '10');
        assert.equal(summary.costs[0].restocked_quantity, '5');
        assert.equal(detail.physical_costs.length, 2);
        assert(detail.physical_costs.every((line: any) => line.sku && line.name));
        assert(csv.includes('"8945"'));
      } else {
        assert(order.cost_reasons.includes('missing_issue_cost'));
        assert.equal(detail.physical_costs.length, 0);
      }
      results.push({
        tenant: firm.tenant,
        order: order.number,
        expected,
        csv_bytes: Buffer.byteLength(csv),
        details_checked: true,
      });
      assert.deepEqual(
        await checkpoint(f.state.tenant, f.state.user),
        firm.checkpoint,
        'Report GET changed accepted business data',
      );
      assert.equal((await fixture(firm.path)).sha256, firm.fixture_sha256);
    }
    // Public output deliberately excludes whole DTOs, credentials and private customer fields.
    console.log(
      JSON.stringify({
        status: 'READ_ONLY_LEDGER_PASS',
        revision,
        firms: results,
        original_fixtures_rewritten: false,
        business_checkpoints_exact: true,
      }),
    );
  }
} finally {
  await pool.end();
}
