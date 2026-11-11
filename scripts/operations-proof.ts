/** Read-only verification of the labelled local stage-009 Chrome scenario. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { pool, tenantTx } from '../server/db';
import { DEMO_TENANT } from '../server/seed';
try {
  const proof = await tenantTx(DEMO_TENANT, async (c) => {
    const orders = (
      await c.query(
        "SELECT id,number,status,tags,note,workflow_status_id,version FROM orders WHERE customer_name IN ('QA Operacje A','QA Operacje B') ORDER BY number",
      )
    ).rows;
    const ids = orders.map((o) => o.id);
    const reservations = (
      await c.query(
        'SELECT order_id,state,quantity FROM reservations WHERE order_id=ANY($1::uuid[]) ORDER BY order_id',
        [ids],
      )
    ).rows;
    const rules = (
      await c.query(
        "SELECT id,name,enabled,version,trigger,priority,delay_seconds FROM automation_rules WHERE name='QA — priorytet po opłaceniu'",
      )
    ).rows;
    const workflow = (await c.query("SELECT * FROM workflow_statuses WHERE name='Priorytet QA'"))
      .rows;
    const runs = (
      await c.query(
        'SELECT id,rule_id,rule_version,event_id,order_id,state,result,error,context FROM automation_runs WHERE order_id=ANY($1::uuid[]) ORDER BY order_id',
        [ids],
      )
    ).rows;
    const batches = (
      await c.query(
        'SELECT b.id,b.state,b.action,j.state AS job_state FROM order_batches b JOIN jobs j ON (j.tenant_id,j.id)=(b.tenant_id,b.job_id) WHERE b.id IN (SELECT batch_id FROM order_batch_items WHERE order_id=ANY($1::uuid[])) ORDER BY b.created_at,b.id',
        [ids],
      )
    ).rows;
    const batchItems = (
      await c.query(
        'SELECT batch_id,order_id,number,state,result,error FROM order_batch_items WHERE batch_id=ANY($1::uuid[]) ORDER BY batch_id,order_id',
        [batches.map((b) => b.id)],
      )
    ).rows;
    const stock = (
      await c.query(
        "SELECT w.code,s.on_hand,s.reserved FROM stock s JOIN products p ON (p.tenant_id,p.id)=(s.tenant_id,s.product_id) JOIN warehouses w ON (w.tenant_id,w.id)=(s.tenant_id,s.warehouse_id) WHERE p.sku='QA-DODATEK' ORDER BY w.code",
      )
    ).rows;
    const previousOrder = (
      await c.query("SELECT id,number,status,total FROM orders WHERE number='DE-20261003-B4EF3B68'")
    ).rows[0];
    const previousDocuments = (
      await c.query('SELECT number,kind,mode FROM documents WHERE order_id=$1 ORDER BY kind,mode', [
        previousOrder.id,
      ])
    ).rows;
    const invalidStock = (
      await c.query(
        'SELECT count(*)::int AS n FROM stock WHERE reserved>on_hand OR reserved<0 OR on_hand<0',
      )
    ).rows[0].n;
    return {
      checked_at: new Date().toISOString(),
      scope: 'local_synthetic_chrome_qa',
      orders,
      reservations,
      rules,
      workflow,
      runs,
      batches,
      batchItems,
      stock,
      previousOrder,
      previousDocuments,
      invalidStock,
    };
  });
  assert.equal(proof.orders.length, 2);
  for (const o of proof.orders) {
    assert.equal(o.status, 'cancelled');
    assert.equal(o.workflow_status_id, null);
    assert.deepEqual(o.tags, ['QA-PILNE']);
    assert.equal(o.note, 'QA: przekazano do kompletacji przez regułę.');
  }
  assert.ok(proof.reservations.every((r) => r.state === 'released'));
  assert.equal(proof.rules.length, 1);
  assert.equal(proof.rules[0].enabled, false);
  assert.equal(proof.runs.length, 2);
  assert.ok(proof.runs.every((r) => r.state === 'done' && r.result.actions.length === 3));
  assert.equal(proof.batches.length, 2);
  assert.ok(proof.batches.every((b) => b.state === 'done' && b.job_state === 'done'));
  assert.equal(proof.batchItems.filter((i) => i.state === 'done').length, 4);
  assert.equal(proof.batchItems.filter((i) => i.state === 'skipped').length, 1);
  assert.equal(proof.stock.find((s) => s.code === 'WAW').on_hand, 11);
  assert.equal(proof.stock.find((s) => s.code === 'WAW').reserved, 0);
  assert.equal(proof.stock.find((s) => s.code === 'POZ').on_hand, 3);
  assert.equal(proof.stock.find((s) => s.code === 'POZ').reserved, 0);
  assert.equal(proof.previousOrder.status, 'return_completed');
  assert.equal(proof.previousDocuments.length, 4);
  assert.equal(proof.invalidStock, 0);
  writeFileSync('docs/operations-qa.json', JSON.stringify(proof, null, 2) + '\n');
  console.log('Local stage-009 QA invariants: PASS; no data mutations.');
} finally {
  await pool.end();
}
