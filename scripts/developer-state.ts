// Read-only verification of the local stage012 QA data after restart. No secrets selected.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
const tenant = '96fa8749-1da7-46f7-9997-c4527c2474bf';
try {
  const health = await (await fetch('http://127.0.0.1:4100/api/health')).json();
  assert.equal(health.schema_revision, '014_returns');
  const keys = (
    await pool.query(
      'SELECT name,prefix,expires_at,revoked_at FROM api_keys WHERE tenant_id=$1 ORDER BY created_at',
      [tenant],
    )
  ).rows;
  assert.equal(keys.length, 4);
  assert(keys.every((k) => k.revoked_at));
  const subscriptions = (
    await pool.query(
      'SELECT id,name,mode,enabled,revoked_at FROM outbound_subscriptions WHERE tenant_id=$1',
      [tenant],
    )
  ).rows;
  assert.equal(subscriptions.length, 1);
  assert.equal(subscriptions[0].enabled, false);
  const deliveries = (
    await pool.query(
      'SELECT d.state,d.response_status,count(*)::int AS count FROM outbound_deliveries d WHERE tenant_id=$1 GROUP BY state,response_status',
      [tenant],
    )
  ).rows;
  assert.deepEqual(deliveries, [{ state: 'delivered', response_status: 202, count: 37 }]);
  const inbox = Number(
    (await pool.query('SELECT count(*) FROM local_webhook_inbox WHERE tenant_id=$1', [tenant]))
      .rows[0].count,
  );
  assert.equal(inbox, 37);
  const orders = (
    await pool.query(
      'SELECT id,number,status,total,currency FROM orders WHERE tenant_id=$1 ORDER BY created_at',
      [tenant],
    )
  ).rows;
  assert.equal(orders.length, 3);
  assert(orders.every((o) => o.status === 'return_completed' && o.total === 26189));
  const stock = (
    await pool.query(
      'SELECT p.sku,s.on_hand,s.reserved FROM stock s JOIN products p ON (p.tenant_id,p.id)=(s.tenant_id,s.product_id) WHERE s.tenant_id=$1 ORDER BY p.sku',
      [tenant],
    )
  ).rows;
  assert.equal(stock.length, 3);
  assert(stock.every((s) => s.on_hand === 5 && s.reserved === 0));
  const invalidStock = Number(
    (
      await pool.query(
        'SELECT count(*) FROM stock WHERE on_hand<0 OR reserved<0 OR reserved>on_hand',
      )
    ).rows[0].count,
  );
  assert.equal(invalidStock, 0);
  const quotaMismatches = Number(
    (
      await pool.query(`SELECT count(*) FROM workspace_usage u WHERE u.used<> CASE resource
    WHEN 'products' THEN (SELECT count(*) FROM products WHERE tenant_id=u.tenant_id)
    WHEN 'orders' THEN (SELECT count(*) FROM orders WHERE tenant_id=u.tenant_id AND date_trunc('month',created_at AT TIME ZONE 'UTC')::date=u.period)
    WHEN 'channels' THEN (SELECT count(*) FROM channels WHERE tenant_id=u.tenant_id)
    WHEN 'warehouses' THEN (SELECT count(*) FROM warehouses WHERE tenant_id=u.tenant_id)
    WHEN 'memberships' THEN (SELECT count(*) FROM memberships WHERE tenant_id=u.tenant_id) END`)
    ).rows[0].count,
  );
  assert.equal(quotaMismatches, 0);
  const prior = (
    await pool.query(
      "SELECT number,status,total,currency FROM orders WHERE number='DE-20261003-87D02A09'",
    )
  ).rows[0];
  assert.equal(prior.status, 'return_completed');
  assert.equal(prior.total, 3299);
  const report = {
    checked_at: new Date().toISOString(),
    health,
    keys,
    subscriptions,
    deliveries,
    inbox,
    orders,
    stock,
    invalidStock,
    quotaMismatches,
    prior_prestashop_order: prior,
  };
  await writeFile(
    process.env.DYNA_STATE_OUTPUT ?? 'docs/developer-state.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(
    JSON.stringify({
      health,
      active_keys: 0,
      deliveries: 37,
      inbox,
      orders: 3,
      invalidStock,
      quotaMismatches,
    }),
  );
} finally {
  await pool.end();
}
