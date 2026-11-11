/** Read-only database proof for the labelled stage-010 Chrome scenario. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { pool, tenantTx } from '../server/db';
import { DEMO_TENANT } from '../server/seed';
try {
  const proof = await tenantTx(DEMO_TENANT, async (c) => {
    const order = (
      await c.query(
        "SELECT id,number,source,external_id,status,total,shipping_cost,warehouse_id FROM orders WHERE number='DE-20261003-87D02A09'",
      )
    ).rows[0];
    assert.ok(order);
    const inbound = (
      await c.query(
        'SELECT id,external_id,state,order_id,normalized,issues,source_hash=imported_hash AS unchanged FROM inbound_orders WHERE order_id=$1',
        [order.id],
      )
    ).rows;
    const items = (
      await c.query('SELECT sku,quantity,line_total FROM order_items WHERE order_id=$1', [order.id])
    ).rows;
    const picks = (
      await c.query('SELECT sku,quantity,scanned FROM order_pick_items WHERE order_id=$1', [
        order.id,
      ])
    ).rows;
    const reservations = (
      await c.query('SELECT state,quantity FROM reservations WHERE order_id=$1', [order.id])
    ).rows;
    const movements = (
      await c.query(
        'SELECT kind,delta FROM stock_movements WHERE order_id=$1 ORDER BY created_at,id',
        [order.id],
      )
    ).rows;
    const documents = (
      await c.query('SELECT number,kind,mode FROM documents WHERE order_id=$1', [order.id])
    ).rows;
    const shipments = (
      await c.query('SELECT carrier,mode,tracking_number FROM shipments WHERE order_id=$1', [
        order.id,
      ])
    ).rows;
    const stock = (
      await c.query(
        "SELECT w.code,s.on_hand,s.reserved FROM stock s JOIN warehouses w ON (w.tenant_id,w.id)=(s.tenant_id,s.warehouse_id) JOIN products p ON (p.tenant_id,p.id)=(s.tenant_id,s.product_id) WHERE p.sku='QA-DODATEK' ORDER BY w.code",
      )
    ).rows;
    const invalidStock = (
      await c.query(
        'SELECT count(*)::int AS n FROM stock WHERE reserved>on_hand OR reserved<0 OR on_hand<0',
      )
    ).rows[0].n;
    return {
      checked_at: new Date().toISOString(),
      scope: 'local_synthetic_chrome_qa',
      order,
      inbound,
      items,
      picks,
      reservations,
      movements,
      documents,
      shipments,
      stock,
      invalidStock,
    };
  });
  assert.equal(proof.order.source, 'prestashop');
  assert.equal(proof.order.external_id, '98001');
  assert.equal(proof.order.status, 'return_completed');
  assert.equal(proof.order.total, 3299);
  assert.equal(proof.order.shipping_cost, 500);
  assert.equal(proof.inbound.length, 1);
  assert.equal(proof.inbound[0].unchanged, true);
  assert.deepEqual(proof.inbound[0].issues, []);
  assert.equal(proof.items.length, 1);
  assert.equal(proof.items[0].line_total, 2799);
  assert.equal(proof.items[0].quantity, 2);
  assert.equal(proof.picks[0].scanned, 2);
  assert.equal(proof.reservations.length, 1);
  assert.equal(proof.reservations[0].state, 'consumed');
  assert.equal(proof.movements.length, 2);
  assert.deepEqual(
    proof.movements.map((v) => v.delta).sort((a, b) => a - b),
    [-2, 2],
  );
  assert.equal(proof.documents.length, 1);
  assert.equal(proof.documents[0].mode, 'demo');
  assert.equal(proof.shipments.length, 1);
  assert.equal(proof.shipments[0].mode, 'demo');
  assert.equal(proof.stock.find((s) => s.code === 'WAW').on_hand, 11);
  assert.equal(proof.stock.find((s) => s.code === 'WAW').reserved, 0);
  assert.equal(proof.invalidStock, 0);
  writeFileSync('docs/prestashop-qa.json', JSON.stringify(proof, null, 2) + '\n');
  console.log(
    JSON.stringify({
      scope: proof.scope,
      order: proof.order.number,
      status: proof.order.status,
      total: proof.order.total,
      stock: proof.stock,
      invalidStock: proof.invalidStock,
    }),
  );
} finally {
  await pool.end();
}
