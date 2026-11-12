// "Automatyzacje - katalog" row 19: a new label after "Anuluj etykietę" (server/shipment-cancel.ts), migration 268.
// The cancelled label keeps its shipment row (status 'canceled') until a new label takes it over: the sealed order
// guards count every shipment row of an order (order_shipments_dispatch_guard 134/137, hashed by 158/159/160), so the
// order keeps one row and order_shipments_guard (268) moves the old identity to shipment268_replaced_labels.
// This file: DEMO (label → Anuluj etykietę → Nowa etykieta DEMO → hand-over → shipped) and the refusals: a cancelled
// label is never printed, handed over or revived, and its number never returns. Carriers: the -simulation and
// -carriers files (one file per group keeps each under the CI per-file limit).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ok, req, refused, packed, shipments, replaced, assertNewLabel, shipped, pool, DEMO_TENANT } from './relabel-after-cancel-fixture';

test('DEMO: label → Anuluj etykietę → Nowa etykieta DEMO → Przekaż kurierowi → shipped; cancelling twice keeps both labels in history', async () => {
  const { o } = await packed();
  await ok(`/api/orders/${o.id}/demo-label`, 'POST', {});
  const [first] = await shipments(o.id);
  const c = await ok(`/api/orders/${o.id}/cancel-label`, 'POST', {});
  assert.deepEqual([c.status, c.fulfilment_stage], ['packed', 'packed']);
  // The cancelled label is neither handed over nor printed.
  await refused(`/api/orders/${o.id}/ship-demo`, 'POST', {}, 409, /utwórz nową etykietę/);
  await refused(`/api/shipments/${first.id}/label`, 'GET', undefined, 409, /anulowana/);
  await ok(`/api/orders/${o.id}/demo-label`, 'POST', {});
  const second = await assertNewLabel(o.id, first.id, 'Symulator lokalny', first.tracking_number);
  // A second cancellation and a third label: both cancelled labels stay in the history, oldest first.
  await ok(`/api/orders/${o.id}/cancel-label`, 'POST', {});
  await ok(`/api/orders/${o.id}/demo-label`, 'POST', {});
  const third = await assertNewLabel(o.id, first.id, 'Symulator lokalny', second.tracking_number);
  assert.deepEqual((await replaced(o.id)).map((r) => [r.tracking_number, r.replaced_by]), [
    [first.tracking_number, second.tracking_number],
    [second.tracking_number, third.tracking_number],
  ]);
  await ok(`/api/orders/${o.id}/ship-demo`, 'POST', {});
  await shipped(o.id);
});


test('refusals: a live label blocks a new one; a cancelled label is no parcel; the cancelled one is never revived, handed over or rewritten', async () => {
  const { o, p } = await packed();
  await ok(`/api/orders/${o.id}/demo-label`, 'POST', {});
  await refused(`/api/orders/${o.id}/demo-label`, 'POST', {}, 409, /Najpierw|ma już etykietę/);
  const label = (await shipments(o.id))[0];
  // A parcel preview made before Anuluj etykietę cannot be applied with the cancelled label as a parcel.
  const source = (await ok(`/api/order-parcels/orders/${o.id}/source`)).source;
  const preview = (await ok(`/api/order-parcels/orders/${o.id}/previews`, 'POST', {
    client_key: randomUUID(), order_version: source.order.version, parcels: [
      { source_kind: 'existing', shipment_id: label.id, cod_minor: label.cod_expected, products: [{ product_id: p.id, quantity: 1 }] },
      { source_kind: 'demo', cod_minor: 10000 - label.cod_expected, products: [{ product_id: p.id, quantity: 1 }] },
    ],
  })).preview;
  await ok(`/api/orders/${o.id}/cancel-label`, 'POST', {});
  await refused(`/api/order-parcels/previews/${preview.id}/apply`, 'POST', { client_key: randomUUID(), scope_hash: preview.scope_hash, confirmed: true }, 409, /anulowanej etykiety nie można przydzielić do planu paczek/);
  // The database itself (order_shipments_guard 268), whatever the application does.
  const c = await pool.connect();
  const attempt = async (sql: string, args: unknown[]) => {
    await c.query('SAVEPOINT s');
    try {
      await c.query(sql, args);
      await c.query('RELEASE SAVEPOINT s');
      return 'ok';
    } catch (e) {
      await c.query('ROLLBACK TO SAVEPOINT s');
      return (e as Error).message;
    }
  };
  try {
    await c.query('BEGIN');
    const REPLACE = 'Anulowaną etykietę zastępuje tylko nowa etykieta przed nadaniem';
    assert.equal(await attempt("UPDATE shipments SET status='created' WHERE id=$1", [label.id]), REPLACE, 'no revival of the cancelled label');
    assert.equal(await attempt('UPDATE shipments SET dispatched_at=now() WHERE id=$1', [label.id]), 'Anulowanej etykiety nie można wydać');
    assert.equal(await attempt("UPDATE shipments SET status='created',tracking_number='DEMO-NEW-1',dispatched_at=now() WHERE id=$1", [label.id]), REPLACE, 'no new label handed over in the same step');
    const other = (await packed()).o;
    assert.equal(await attempt("UPDATE shipments SET status='created',tracking_number='DEMO-NEW-2',order_id=$2 WHERE id=$1", [label.id, other.id]), REPLACE, 'never moved to another order');
    assert.match(await attempt("UPDATE shipments SET status='created',tracking_number='DEMO-NEW-3',carrier='' WHERE id=$1", [label.id]), /jawnej tożsamości przewoźnika/, 'the new label passes the checks of an inserted one');
    // A valid replacement writes the history, which is immutable.
    assert.equal(await attempt("UPDATE shipments SET status='created',tracking_number='DEMO-NEW-4' WHERE id=$1", [label.id]), 'ok');
    const h = (await c.query('SELECT id,tracking_number,replaced_by FROM shipment268_replaced_labels WHERE shipment_id=$1', [label.id])).rows;
    assert.deepEqual(h.map((r) => [r.tracking_number, r.replaced_by]), [[label.tracking_number, 'DEMO-NEW-4']]);
    assert.equal(await attempt("UPDATE shipment268_replaced_labels SET tracking_number='X' WHERE id=$1", [h[0].id]), 'Historia zastąpionych etykiet jest niezmienna');
    assert.equal(await attempt('DELETE FROM shipment268_replaced_labels WHERE id=$1', [h[0].id]), 'Historia zastąpionych etykiet jest niezmienna');
    // The cancelled number never comes back: not after a second cancellation on the same row, not on another order.
    const REVIVE = 'Numer anulowanej etykiety nie wraca do obiegu';
    assert.equal(await attempt("UPDATE shipments SET status='canceled' WHERE id=$1", [label.id]), 'ok');
    assert.equal(await attempt("UPDATE shipments SET status='created',tracking_number=$2 WHERE id=$1", [label.id, label.tracking_number]), REVIVE);
    assert.equal(await attempt(
      "INSERT INTO shipments(id,tenant_id,order_id,carrier,tracking_number,mode,cod_expected) VALUES($1,$2,$3,$4,$5,'demo',0)",
      [randomUUID(), DEMO_TENANT, other.id, label.carrier, label.tracking_number],
    ), REVIVE);
    // The application role only reads its tenant's history.
    await c.query('SET LOCAL ROLE dyna_app');
    assert.match(await attempt(
      "INSERT INTO shipment268_replaced_labels(tenant_id,shipment_id,order_id,carrier,tracking_number,mode,cod_expected,label_created_at,replaced_by) VALUES($1,$2,$3,'x','y','demo',0,now(),'z')",
      [DEMO_TENANT, label.id, o.id],
    ), /permission denied/);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
  assert.equal((await shipments(o.id))[0].status, 'canceled', 'the rolled back attempts changed nothing');
});
