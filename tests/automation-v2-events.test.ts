// Automation rules v2 events (lane J) without a database: status change filter, trigger mapping, carrier statuses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statusChangeMatches, statusChangeOf, v2TriggersFor } from '../server/automation-v2-triggers';
import { statusChangeProblem } from '../server/automation-v2-schema';
import { shipmentStatusOf, SHIPMENT_STATUSES } from '../shared/shipment-status';
import { labelCancelScope } from '../server/shipment-cancel';

test('statusChangeOf reads stage events and own-status changes only', () => {
  assert.deepEqual(statusChangeOf('order.picking', { from: 'paid' }), { from: 'paid', to: 'picking' });
  assert.deepEqual(statusChangeOf('order.paid', {}), { from: null, to: 'paid' });
  const wf = '6f1c0d4e-1111-4222-8333-444455556666';
  assert.deepEqual(statusChangeOf('order.workflow_changed', { from: null, to: wf, stage: 'paid' }), { from: null, to: wf });
  assert.equal(statusChangeOf('order.workflow_changed', { from: wf }), null, 'no target, no change');
  assert.equal(statusChangeOf('order.tags_changed', { from: 'x' }), null);
  assert.equal(statusChangeOf('order.ready_to_ship', { from: 'packed' }), null, 'a derived stage is not an event');
});

test('statusChangeMatches: empty = any; from and to over all changes of the transaction', () => {
  const changes = [{ from: 'paid', to: 'picking' }];
  assert.equal(statusChangeMatches(undefined, changes), true);
  assert.equal(statusChangeMatches({ from: [], to: [] }, []), true);
  assert.equal(statusChangeMatches({ from: ['paid'], to: ['picking'] }, changes), true);
  assert.equal(statusChangeMatches({ from: ['new'], to: ['picking'] }, changes), false);
  assert.equal(statusChangeMatches({ from: [], to: ['packed'] }, changes), false);
  assert.equal(statusChangeMatches({ from: ['paid'], to: [] }, changes), true);
  assert.equal(statusChangeMatches({ from: ['paid'], to: [] }, undefined), false, 'a filter needs a status change');
  assert.equal(statusChangeMatches({ from: ['paid'], to: [] }, [{ from: null, to: 'paid' }]), false, 'unknown previous status');
  const wf = 'wf-1';
  // set_workflow emits the stage change and the own-status change in one transaction.
  assert.equal(statusChangeMatches({ from: ['paid'], to: [wf] }, [{ from: 'paid', to: 'picking' }, { from: null, to: wf }]), true);
});

test('v2TriggersFor raises the six lane J events from their order events', () => {
  for (const kind of ['order.item_missing', 'stock.changed', 'shipment.cancelled', 'shipment.status_changed', 'customer_message.received'])
    assert.deepEqual(v2TriggersFor(kind).sort(), ['order.matches', kind].sort(), kind);
  assert.ok(v2TriggersFor('order.packed').includes('order.status_changed'));
});

test('statusChangeProblem refuses another trigger, the derived stage and unknown codes', () => {
  assert.equal(statusChangeProblem('order.status_changed', { from: ['paid'], to: ['packed'] }), null);
  assert.equal(statusChangeProblem('order.status_changed', { from: [], to: ['6f1c0d4e-1111-4222-8333-444455556666'] }), null);
  assert.match(statusChangeProblem('order.created', { from: ['paid'], to: [] })!, /tylko dla zdarzenia/);
  assert.equal(statusChangeProblem('order.created', { from: [], to: [] }), null);
  assert.match(statusChangeProblem('order.status_changed', { from: ['ready_to_ship'], to: [] })!, /Nieznany status/);
  assert.match(statusChangeProblem('order.status_changed', { from: [], to: ['DROP TABLE'] })!, /Nieznany status/);
});

test('shipmentStatusOf groups carrier codes into the six statuses', () => {
  const cases: Array<[string, string | null]> = [
    ['collected_from_sender', 'picked_up'],
    ['taken_by_courier', 'picked_up'],
    ['out_for_delivery', 'in_transit'],
    ['avizo', 'ready_to_pickup'],
    ['ready_to_pickup', 'ready_to_pickup'],
    ['delivered', 'delivered'],
    ['return_in_transit', 'returned_to_sender'],
    ['delivery_failed', 'problem'],
    ['lost', 'problem'],
    ['created', null],
    ['confirmed', null],
    ['canceled', null],
    ['unknown_code', null],
  ];
  for (const [code, group] of cases) assert.equal(shipmentStatusOf(code), group, code);
  assert.equal(shipmentStatusOf(null), null);
  for (const s of SHIPMENT_STATUSES) assert.equal(shipmentStatusOf(s), s, 'a group maps to itself');
});

test('labelCancelScope: DEMO local, simulated carrier simulated, a bought real label refused with the place to cancel', () => {
  assert.equal(labelCancelScope({ mode: 'demo', channel_id: null }, null), 'local');
  assert.equal(labelCancelScope({ mode: 'demo', channel_id: 'ch' }, 'inpost'), 'simulation');
  assert.throws(() => labelCancelScope({ mode: 'live', channel_id: 'ch' }, 'inpost'), (e: any) => e.status === 409 && /Managerze Paczek/.test(e.message));
  assert.throws(() => labelCancelScope({ mode: 'sandbox', channel_id: 'ch' }, 'dpd'), (e: any) => e.status === 409 && /DPD/.test(e.message));
  assert.throws(() => labelCancelScope({ mode: 'live', channel_id: 'ch' }, 'gls'), (e: any) => e.status === 409 && /nie pozwala/.test(e.message));
});
