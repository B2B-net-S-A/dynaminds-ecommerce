import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { shipDemo } from '../server/domain';
import { lockedShipping } from '../server/shipping';
import { Problem } from '../server/errors';
import { seed } from './fixtures';
import { stocktakeAdjustmentFixture } from './stocktake-adjustments-fixture';
import { productCatalogFacts } from './product-catalogs-fixture';

assert.equal(process.env.DYNA_TEST, 'true');
assert.match(new URL(process.env.DATABASE_URL!).pathname, /^\/dynaminds_test_\d+$/);
let app: Awaited<ReturnType<typeof buildApp>>;
before(async () => { await migrate(); await seed(); app = await buildApp(); });
after(async () => { await app?.close(); await pool.end(); });

async function packed(on: boolean) {
  const f = await stocktakeAdjustmentFixture(app, on);
  const order = await f.ok('/orders', 'POST', {
    source: 'manual', customer_name: 'Own terminal dispatch gate', email: 'dispatch168@example.test',
    address: { street: 'Testowa 168', city: 'Warszawa', postal_code: '00-168', country: 'PL', phone: '500000168' },
    warehouse_id: f.warehouse.id, payment_mode: 'prepaid', currency: 'PLN', shipping_cost: 0,
    items: f.products.map(p => ({ product_id: p.id, quantity: 3 })),
  }, 201);
  await f.ok('/orders/' + order.id + '/payments', 'POST', { client_key: randomUUID(), version: Number(order.version),
    kind: 'receipt', amount: order.total, currency: 'PLN', method: 'other', reference: 'Local declared fixture168', confirmed: true });
  await f.ok('/orders/' + order.id + '/status', 'PATCH', { status: 'picking' });
  if (on) {
    const allocations = await f.ok('/wms-lots/orders/' + order.id + '/allocations');
    assert.equal(allocations.meta.cursor, null);
    for (const r of allocations.data) {
      const p = f.products.find(p => p.id === r.product_id); assert(p);
      for (let n = 0; n < r.quantity; n++) await f.ok('/orders/' + order.id + '/scan', 'POST', {
        client_key: randomUUID(), code: p.sku, location: r.location, layer_id: r.layer_id,
      });
    }
  } else {
    const holds = (await pool.query('SELECT * FROM reservation_locations WHERE tenant_id=$1 AND order_id=$2', [f.tenant, order.id])).rows;
    for (const r of holds) {
      const p = f.products.find(p => p.id === r.product_id); assert(p);
      for (let n = 0; n < r.quantity; n++) await f.ok('/orders/' + order.id + '/scan', 'POST', {
        client_key: randomUUID(), code: p.sku, location: r.location,
      });
    }
  }
  await f.ok('/orders/' + order.id + '/status', 'PATCH', { status: 'packed' });
  return { ...f, order };
}

test('shipping waits on the warehouse before taking order/plan locks', async () => {
  const f = await packed(false);
  const channel = await f.ok('/shipping/example', 'POST', {});
  const plan = await f.ok('/orders/' + f.order.id + '/shipping/preview', 'POST', {
    channel_id: channel.id, service: 'inpost_locker_standard',
    receiver: { first_name: 'Own', last_name: 'Warehouse lock', email: 'dispatch168@example.test', phone: '500000168' },
    target_point: 'WAW01M', template: 'small', weight: 1, cod: 0, insurance: 0,
  });
  const held = await pool.connect(), probe = await pool.connect();
  let pending: Promise<unknown> | undefined;
  try {
    await held.query('BEGIN');
    await held.query('SELECT id FROM warehouses WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [f.tenant, f.warehouse.id]);
    const pid = (await held.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    pending = tenantTx(f.tenant, c => lockedShipping(c, plan.id)); void pending.catch(() => {});
    const deadline = Date.now() + 5000; let observed = false;
    while (Date.now() < deadline) {
      const waits = (await pool.query(`SELECT query FROM pg_stat_activity WHERE datname=current_database()
        AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))`, [pid])).rows;
      if (waits.some(r => /warehouse_inventory_policy_lock/.test(r.query))) { observed = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert(observed, 'Warehouse wait must be observed against the actual blocked backend');
    await probe.query('BEGIN');
    assert.equal((await probe.query('SELECT id FROM orders WHERE tenant_id=$1 AND id=$2 FOR UPDATE NOWAIT', [f.tenant, f.order.id])).rowCount, 1);
    assert.equal((await probe.query('SELECT id FROM shipping_plans WHERE tenant_id=$1 AND id=$2 FOR UPDATE NOWAIT', [f.tenant, plan.id])).rowCount, 1);
    await probe.query('COMMIT'); await held.query('COMMIT');
    const result = await pending as { p: { id: string }; o: { id: string } };
    assert.equal(result.p.id, plan.id); assert.equal(result.o.id, f.order.id);
  } finally {
    await probe.query('ROLLBACK').catch(() => {}); probe.release();
    await held.query('ROLLBACK').catch(() => {}); held.release();
    if (pending) await pending.catch(() => {});
  }
});

async function observeFinalWait(held: PoolClient, key: boolean, hydrated: () => boolean) {
  const pid = (await held.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const waits = (await pool.query(`SELECT query FROM pg_stat_activity WHERE datname=current_database()
      AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))`, [pid])).rows;
    const pattern = key ? /wms_key_grant|FROM api_keys\s+WHERE tenant_id=/ : /wms_current_role|FROM memberships WHERE tenant_id=/;
    if (waits.some(r => pattern.test(r.query))) {
      assert(hydrated(), 'Actual physical writer and response hydration must finish before the observed final grant wait');
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('No actual final membership/key lock wait observed');
}

for (const on of [false, true]) {
  test(`${on ? 'ON' : 'OFF'} valid dispatch commits one physical issue with terminal authorization`, async () => {
    const f = await packed(on), before = await productCatalogFacts(f.tenant);
    const result = await tenantTx(f.tenant, c => shipDemo(c, f.actor, f.order.id));
    assert.equal(result.status, 'shipped');
    const after = await productCatalogFacts(f.tenant);
    assert.equal(after.stock_movements.length - before.stock_movements.length, 3);
    assert.equal(after.stock_location_movements.length - before.stock_location_movements.length, 6);
    assert.equal(after.shipments.length - before.shipments.length, 1);
    assert.equal(after.wms_issue_fragments.length - before.wms_issue_fragments.length, on ? 6 : 0);
  });
  for (const withdrawal of ['role', 'scope', 'revoked', 'expired'] as const) {
    test(`${on ? 'ON' : 'OFF'} ${withdrawal} withdrawn after hydrated dispatch and observed final wait rolls back all issue rows`, async () => {
      const f = await packed(on);
      const key = withdrawal === 'role' ? null : await f.ok('/developer/keys', 'POST', {
        name: 'Own final dispatch key168', scopes: ['orders:read','orders:write','inventory:read','inventory:write'],
      }, 201);
      const before = await productCatalogFacts(f.tenant);
      const original = key ? before.api_keys.find(x => x.row.id === key.id)!.row : null;
      const held = await pool.connect(); let pending: Promise<unknown> | undefined, hydrated = false;
      try {
        await held.query('BEGIN');
        if (key) await held.query('UPDATE api_keys SET scopes=scopes WHERE tenant_id=$1 AND id=$2', [f.tenant, key.id]);
        else await held.query('UPDATE memberships SET role=role WHERE tenant_id=$1 AND user_id=$2', [f.tenant, f.user]);
        pending = tenantTx(f.tenant, async c => {
          const result = await shipDemo(c, { ...f.actor, ...(key ? { apiKeyId: key.id } : {}) }, f.order.id);
          hydrated = true; return result;
        });
        void pending.catch(() => {});
        await observeFinalWait(held, !!key, () => hydrated);
        if (withdrawal === 'role') await held.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [f.tenant, f.user]);
        else if (withdrawal === 'scope') await held.query("UPDATE api_keys SET scopes=ARRAY['orders:read','inventory:read','inventory:write'] WHERE tenant_id=$1 AND id=$2", [f.tenant, key!.id]);
        else if (withdrawal === 'revoked') await held.query('UPDATE api_keys SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2', [f.tenant, key!.id]);
        else await held.query("UPDATE api_keys SET expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND id=$2", [f.tenant, key!.id]);
        await held.query('COMMIT');
        await assert.rejects(pending, e => e instanceof Problem && e.status === (withdrawal === 'expired' || withdrawal === 'revoked' ? 401 : 403));
      } finally {
        await held.query('ROLLBACK').catch(() => {}); held.release();
        if (pending) await pending.catch(() => {});
        if (key) await pool.query('UPDATE api_keys SET scopes=$3,revoked_at=$4,expires_at=$5 WHERE tenant_id=$1 AND id=$2',
          [f.tenant, key.id, original.scopes, original.revoked_at, original.expires_at]);
        else await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [f.tenant, f.user]);
      }
      assert.deepEqual(await productCatalogFacts(f.tenant), before, 'Every own persisted row must remain exact after rejected dispatch');
    });
  }
}
