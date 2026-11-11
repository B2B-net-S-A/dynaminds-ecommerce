import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { seed } from './fixtures';
import { returnAssistantFixture } from './return-assistant-fixture';
import { cancelOrder, transition } from '../server/domain';
import { previewWarehouseInventoryPolicy, commitWarehouseInventoryPolicy } from '../server/warehouse-inventory-policies';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? '');
assert(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname));
assert.match(database.pathname, /^\/dynaminds_test_[a-zA-Z0-9_]+$/);
let app: Awaited<ReturnType<typeof buildApp>>;
before(async () => {
  await migrate(); await seed();
  app = await buildApp({ integrationTransport: async () => { throw Error('No provider in order policy lock test'); } });
});
after(async () => { try { await app?.close(); } finally { await pool.end(); } });

async function waiter(observer: PoolClient, blocker: number, query: RegExp): Promise<number> {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    await observer.query('SELECT pg_stat_clear_snapshot()');
    const rows = (await observer.query<{ pid: number; query: string }>(`SELECT pid,query FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))`, [blocker])).rows;
    const found = rows.find(row => query.test(row.query));
    if (found) return found.pid;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Expected the actual order/warehouse blocking chain');
}

// OFF has no WMS writer serialization hiding the warehouse/order inversion.
// ON writer serialization is covered by warehouse-parcel-policy-locks.test.ts.
for (const action of ['cancel', 'status'] as const) test(`${action} waits on actual warehouse policy row before locking its order`, async () => {
  const f = await returnAssistantFixture(app, false);
  const order = await f.ok('/orders', 'POST', {
    source: 'manual', customer_name: 'Own order policy lock buyer', email: 'order-lock@example.test', address: f.order.address,
    warehouse_id: f.warehouse, payment_mode: action === 'status' ? 'cod' : 'prepaid', currency: 'PLN', shipping_cost: 0,
    items: [{ product_id: f.product.id, quantity: 1 }],
  }, 201);
  const policyPreview = (await previewWarehouseInventoryPolicy(f.actor, f.warehouse,
    { client_key: randomUUID(), version: '0', usage: 'sale', enabled: true })).preview;
  assert.equal(policyPreview.ready, true);
  assert.equal((await commitWarehouseInventoryPolicy(f.actor, policyPreview.id,
    { client_key: randomUUID(), scope_hash: policyPreview.scope_hash, confirmed: true })).operation.after.version, '1');
  const originalItems = f.order.items;
  const stockBefore = (await pool.query('SELECT on_hand,reserved FROM stock WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3',
    [f.tenant, f.warehouse, f.product.id])).rows[0];
  const controller = await pool.connect();
  let changed: Promise<Awaited<ReturnType<typeof cancelOrder>>> | undefined;
  try {
    await controller.query('BEGIN');
    const controllerPid = (await controller.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    const held = await controller.query('SELECT warehouse_id FROM warehouse_inventory_policies WHERE tenant_id=$1 AND warehouse_id=$2 FOR UPDATE', [f.tenant, f.warehouse]);
    assert.equal(held.rowCount, 1);
    changed = tenantTx(f.tenant, c => action === 'cancel'
      ? cancelOrder(c, f.actor, order.id) : transition(c, f.actor, order.id, 'picking'));
    changed.catch(() => undefined);
    await waiter(controller, controllerPid, /warehouse_inventory_policy_lock/);
    // A real NOWAIT probe proves the waiting operation has not already taken
    // its order lock. This assertion fails on the former order-first code.
    await controller.query('SAVEPOINT order_probe');
    const probe = await controller.query('SELECT id FROM orders WHERE tenant_id=$1 AND id=$2 FOR UPDATE NOWAIT', [f.tenant, order.id]);
    assert.equal(probe.rowCount, 1);
    await controller.query('ROLLBACK TO SAVEPOINT order_probe');
    await controller.query('COMMIT');
    assert.equal((await changed).status, action === 'cancel' ? 'cancelled' : 'picking');
    assert.deepEqual((await f.ok('/orders/' + f.order.id)).items, originalItems);
    const stockAfter = (await pool.query('SELECT on_hand,reserved FROM stock WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3',
      [f.tenant, f.warehouse, f.product.id])).rows[0];
    assert.equal(stockAfter.on_hand, stockBefore.on_hand, 'Cancellation/status do not issue or restock goods');
    assert.equal(stockAfter.reserved, stockBefore.reserved - (action === 'cancel' ? 1 : 0));
    const reservation = (await pool.query('SELECT quantity,state FROM reservations WHERE tenant_id=$1 AND order_id=$2', [f.tenant, order.id])).rows[0];
    assert.deepEqual(reservation, { quantity: 1, state: action === 'cancel' ? 'released' : 'active' });
  } finally {
    await controller.query('ROLLBACK').catch(() => undefined); controller.release();
    await Promise.allSettled([changed].map(promise => promise?.catch(() => undefined)));
  }
});
