import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { pool } from '../server/db';
try {
  const organizations = (
    await pool.query(`
    SELECT t.id,t.name,t.plan,t.currency,t.locale,
      (SELECT count(*)::int FROM memberships m WHERE m.tenant_id=t.id) AS members,
      (SELECT count(*)::int FROM warehouses w WHERE w.tenant_id=t.id) AS warehouses,
      (SELECT count(*)::int FROM products p WHERE p.tenant_id=t.id) AS products,
      (SELECT count(*)::int FROM orders o WHERE o.tenant_id=t.id) AS orders
    FROM tenants t WHERE t.name IN ('QA SaaS 20261004','QA SaaS Konto własne') ORDER BY t.name
  `)
  ).rows;
  assert.equal(organizations.length, 2);
  const main = organizations.find((o) => o.name === 'QA SaaS 20261004')!;
  assert.equal(main.plan, 'business');
  assert.equal(main.members, 2);
  assert.equal(main.warehouses, 2);
  assert.equal(main.products, 0);
  assert.equal(main.orders, 0);
  const own = organizations.find((o) => o.name === 'QA SaaS Konto własne')!;
  assert.equal(own.currency, 'EUR');
  assert.equal(own.plan, 'starter');
  assert.equal(own.members, 1);
  const memberships = (
    await pool.query(
      `SELECT t.name AS organization,m.role,u.email FROM memberships m JOIN tenants t ON t.id=m.tenant_id JOIN users u ON u.id=m.user_id WHERE u.email='qa-saas-20261004@example.test' ORDER BY t.name`,
    )
  ).rows;
  assert.equal(memberships.find((m) => m.organization === main.name)?.role, 'viewer');
  assert.equal(memberships.find((m) => m.organization === own.name)?.role, 'admin');
  const invitations = (
    await pool.query(
      'SELECT email,role,status,expires_at,accepted_by IS NOT NULL AS accepted FROM workspace_invitations WHERE tenant_id=$1',
      [main.id],
    )
  ).rows;
  assert.equal(invitations.length, 1);
  assert.equal(invitations[0].status, 'accepted');
  assert.equal(invitations[0].accepted, true);
  const mismatches = (
    await pool.query(`WITH actual AS (
    SELECT tenant_id,'products'::text AS resource,'2000-01-01'::date AS period,count(*) AS used FROM products GROUP BY tenant_id
    UNION ALL SELECT tenant_id,'warehouses','2000-01-01',count(*) FROM warehouses GROUP BY tenant_id
    UNION ALL SELECT tenant_id,'channels','2000-01-01',count(*) FROM channels GROUP BY tenant_id
    UNION ALL SELECT tenant_id,'memberships','2000-01-01',count(*) FROM memberships GROUP BY tenant_id
    UNION ALL SELECT tenant_id,'orders',date_trunc('month',created_at AT TIME ZONE 'UTC')::date,count(*) FROM orders GROUP BY tenant_id,date_trunc('month',created_at AT TIME ZONE 'UTC')::date
  ) SELECT count(*)::int AS n FROM actual a FULL JOIN workspace_usage u USING(tenant_id,resource,period) WHERE coalesce(a.used,0)<>coalesce(u.used,0)`)
  ).rows[0].n;
  assert.equal(mismatches, 0);
  const invalidStock = (
    await pool.query(
      'SELECT count(*)::int AS n FROM stock WHERE reserved<0 OR reserved>on_hand OR on_hand<0',
    )
  ).rows[0].n;
  assert.equal(invalidStock, 0);
  const priorOrder = (
    await pool.query("SELECT number,status,total FROM orders WHERE number='DE-20261003-87D02A09'")
  ).rows[0];
  assert.equal(priorOrder.status, 'return_completed');
  assert.equal(priorOrder.total, 3299);
  const adminsMissing = (
    await pool.query(
      "SELECT count(*)::int AS n FROM tenants t WHERE NOT EXISTS(SELECT 1 FROM memberships m WHERE m.tenant_id=t.id AND m.role='admin')",
    )
  ).rows[0].n;
  assert.equal(adminsMissing, 0);
  const audit = (
    await pool.query(
      "SELECT action,count(*)::int AS count FROM audit_events WHERE tenant_id=ANY($1::uuid[]) AND action LIKE 'workspace.%' GROUP BY action ORDER BY action",
      [organizations.map((o) => o.id)],
    )
  ).rows;
  const result = {
    checked_at: new Date().toISOString(),
    environment: 'local PostgreSQL; read-only evidence collection',
    organizations,
    memberships,
    invitations,
    audit,
    invariants: {
      quota_counter_mismatches: mismatches,
      invalid_stock: invalidStock,
      organizations_without_admin: adminsMissing,
    },
    preserved_prestashop_order: priorOrder,
    secrets_included: false,
  };
  writeFileSync('docs/workspaces-qa.json', JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} finally {
  await pool.end();
}
