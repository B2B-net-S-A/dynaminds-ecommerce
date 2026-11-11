/** Which shipments block a new label after "Anuluj etykietę" (migration 268).
 * Run: node node_modules/tsx/dist/cli.mjs --test web/order-relabel.test.mjs */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isCancelledLabel, liveShipments, needsNewLabel } from './order-relabel.ts';

const cancelled = { status: 'canceled', dispatched_at: null };
const live = { status: 'label_ready', dispatched_at: null };
const dispatchedCancelledByCarrier = { status: 'canceled', dispatched_at: '2026-11-11T10:00:00Z' };

test('a label cancelled before hand-over is no live shipment', () => {
  assert.equal(isCancelledLabel(cancelled), true);
  assert.deepEqual(liveShipments([cancelled]), []);
  assert.equal(needsNewLabel([cancelled]), true);
});

test('a live shipment, or one the carrier cancelled after hand-over, still blocks a new label', () => {
  assert.equal(needsNewLabel([live]), false);
  assert.equal(isCancelledLabel(dispatchedCancelledByCarrier), false);
  assert.equal(needsNewLabel([dispatchedCancelledByCarrier]), false);
  assert.deepEqual(liveShipments([cancelled, live]), [live]);
});

test('an order without shipments gets its first label, not a new one', () => {
  assert.equal(needsNewLabel([]), false);
});
