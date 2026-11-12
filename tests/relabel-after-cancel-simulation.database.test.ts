// Migration 268, carrier accounts in simulation: DPD (label → Anuluj etykietę → new DPD label) and InPost (a cancelled
// DEMO label → InPost create and buy), each handed over until the order is shipped. Setup: relabel-after-cancel-fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ok, packed, shipments, plan, run, dpdLabel, assertNewLabel, shipped } from './relabel-after-cancel-fixture';

test('carrier account in simulation (DPD): label → Anuluj etykietę → new DPD label → hand-over → shipped', async () => {
  const { o } = await packed();
  const p1 = await dpdLabel(o.id);
  assert.equal(p1.state, 'ready');
  const [first] = await shipments(o.id);
  await ok(`/api/orders/${o.id}/cancel-label`, 'POST', {});
  assert.equal((await plan(p1.id)).state, 'cancelled');
  const p2 = await dpdLabel(o.id);
  assert.equal(p2.state, 'ready');
  assert.equal(p2.shipment_id, first.id, 'the new plan binds the row it took over');
  await assertNewLabel(o.id, first.id, 'DPD Polska', first.tracking_number);
  await ok(`/api/dpd-shipping/${p2.id}/dispatch`, 'POST', {});
  await shipped(o.id);
});


test('carrier account in simulation (InPost): DEMO label cancelled → InPost label (create, buy) → hand-over → shipped', async () => {
  const { o } = await packed();
  await ok(`/api/orders/${o.id}/demo-label`, 'POST', {});
  const [first] = await shipments(o.id);
  await ok(`/api/orders/${o.id}/cancel-label`, 'POST', {});
  const ch = (await ok('/api/shipping/example', 'POST', {})).id;
  const preview = await ok(`/api/orders/${o.id}/shipping/preview`, 'POST', {
    channel_id: ch, service: 'inpost_locker_standard', target_point: 'WAW01A', template: 'small', weight: 1, cod: 10000, insurance: 10000,
    receiver: { first_name: 'Kupujący', last_name: 'QA', email: 'buyer@example.test', phone: '500600700' },
  });
  await run('inpost', (await ok(`/api/shipping-plans/${preview.id}/queue`, 'POST', {})).job_id);
  const quoted = await plan(preview.id);
  await run('inpost', (await ok(`/api/shipping-plans/${preview.id}/buy`, 'POST', { offer_id: quoted.offers[0].id, confirm_cost: true, ack_unknown_rate: true })).job_id);
  const ready = await plan(preview.id);
  assert.equal(ready.state, 'ready');
  assert.equal(ready.shipment_id, first.id);
  await assertNewLabel(o.id, first.id, 'InPost ShipX', first.tracking_number);
  await ok(`/api/shipping-plans/${preview.id}/dispatch`, 'POST', {});
  await shipped(o.id);
});
