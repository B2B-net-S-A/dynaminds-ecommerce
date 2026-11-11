/** Pure rules of the 251 B2B network lifecycle (prepared as 258): B2B-002 link, B2B-003 mapping and price sync,
 * B2B-004-X supplier decision, B2B-005 dropshipping tracking. No database. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DECISION_WINDOW_HOURS, decisionPlan, disconnectPlan, priceSyncPlan, rebindPlan, reconnectPlan, sweepPlan, trackingToCopy, unbindPlan,
} from '../server/b2b-network-lifecycle-model';
import { Problem } from '../server/errors';

const refused = (fn: () => unknown, status: number, text: RegExp) =>
  assert.throws(fn, (e) => e instanceof Problem && e.status === status && text.test(e.message));

test('B2B-002: a second disconnect is a replay; only the same buyer company reconnects', () => {
  assert.equal(disconnectPlan(null), 'disconnect');
  assert.equal(disconnectPlan('connected'), 'disconnect');
  assert.equal(disconnectPlan('disconnected'), 'replay');
  assert.equal(reconnectPlan(null, 'b'), 'insert');
  assert.equal(reconnectPlan({ state: 'disconnected', tenant_id: 'b' }, 'b'), 'reconnect');
  refused(() => reconnectPlan({ state: 'disconnected', tenant_id: 'a' }, 'b'), 409, /inną firmą/);
  refused(() => reconnectPlan({ state: 'connected', tenant_id: 'b' }, 'b'), 409, /juz polaczona/);
});

test('B2B-003: unbind and rebind; the 144 proof only reattaches the same product', () => {
  const free = { product_id: 'p1', proof: false }, proven = { product_id: 'p1', proof: true };
  refused(() => unbindPlan({ product_id: null, proof: false }, null), 409, /nie ma powiązania/);
  assert.equal(unbindPlan(free, null), 'unbind');
  assert.equal(unbindPlan(free, 'bound'), 'unbind');
  assert.equal(unbindPlan(proven, 'unbound'), 'replay');
  assert.equal(rebindPlan(free, null, 'p1'), 'replay');
  assert.equal(rebindPlan(free, 'unbound', 'p1'), 'reattach');
  assert.equal(rebindPlan(free, 'bound', 'p2'), 'switch');
  assert.equal(rebindPlan(free, 'unbound', 'p2'), 'switch');
  assert.equal(rebindPlan(proven, 'unbound', 'p1'), 'reattach');
  refused(() => rebindPlan(proven, 'unbound', 'p2'), 409, /tylko do tego samego produktu/);
  refused(() => rebindPlan({ product_id: null, proof: false }, null, 'p2'), 409, /nie ma powiązania/);
});

test('B2B-003: the purchase price sync is exact to the grosz and idempotent', () => {
  assert.deepEqual(priceSyncPlan(null, { price: 12345, currency: 'PLN' }), { changed: true, before: null, after: { minor: 12345, currency: 'PLN' } });
  assert.equal(priceSyncPlan({ minor: 12345, currency: 'PLN' }, { price: 12345, currency: 'PLN' }).changed, false);
  assert.equal(priceSyncPlan({ minor: 12345, currency: 'PLN' }, { price: 12346, currency: 'PLN' }).changed, true, 'one grosz');
  assert.equal(priceSyncPlan({ minor: 12345, currency: 'PLN' }, { price: 12345, currency: 'EUR' }).changed, true, 'currency');
  for (const bad of [{ price: 1.5, currency: 'PLN' }, { price: -1, currency: 'PLN' }, { price: '100', currency: 'PLN' }, { price: 100, currency: 'pln' }, { price: 100000000001, currency: 'PLN' }])
    refused(() => priceSyncPlan(null, bad), 409, /poprawnej ceny/);
  assert.equal(priceSyncPlan(null, { price: 0, currency: 'PLN' }).after.minor, 0);
});

test('B2B-004-X: explicit decisions need a pending row of the version before the deadline', () => {
  const now = new Date('2026-10-27T12:00:00Z'), by = new Date(now.getTime() + DECISION_WINDOW_HOURS * 3600e3);
  const pending = { state: 'pending' as const, version: 1, decide_by: by };
  assert.equal(DECISION_WINDOW_HOURS, 48);
  assert.equal(decisionPlan(pending, 'accept', 1, now), 'accepted');
  assert.equal(decisionPlan(pending, 'reject', 1, now), 'rejected');
  refused(() => decisionPlan(pending, 'accept', 2, now), 409, /zmieniło się/);
  refused(() => decisionPlan(pending, 'accept', 1, by), 409, /Termin decyzji minął/);
  assert.equal(decisionPlan({ ...pending, state: 'accepted', version: 2 }, 'accept', 1, now), 'replay');
  refused(() => decisionPlan({ ...pending, state: 'accepted', version: 2 }, 'reject', 2, now), 409, /już zapadła/);
  for (const state of ['expired', 'withdrawn'] as const) refused(() => decisionPlan({ ...pending, state }, 'accept', 1, now), 409, /już zapadła/);
});

test('B2B-004-X: the sweep expires only untouched orders past the deadline', () => {
  const now = new Date('2026-10-27T12:00:00Z'), past = new Date(now.getTime() - 1), future = new Date(now.getTime() + 1);
  assert.equal(sweepPlan('new', false, now, future), 'wait');
  assert.equal(sweepPlan('new', false, now, past), 'expire');
  assert.equal(sweepPlan('new', false, now, now), 'expire', 'the deadline itself');
  assert.equal(sweepPlan('paid', false, now, past), 'expire');
  for (const s of ['picking', 'packed', 'shipped', 'delivered', 'completed']) assert.equal(sweepPlan(s, false, now, past), 'accept', s);
  assert.equal(sweepPlan('new', true, now, past), 'accept', 'a dispatched parcel');
  assert.equal(sweepPlan('cancelled', false, now, future), 'reject');
});

test('B2B-005: only dispatched parcels with a number are copied, once, oldest first', () => {
  const d = (s: string) => new Date('2026-10-27T' + s + 'Z');
  const rows = [
    { id: 'c', carrier: 'DPD', tracking_number: ' 0000123 ', dispatched_at: d('10:00:00') },
    { id: 'a', carrier: 'InPost', tracking_number: 'X1', dispatched_at: d('09:00:00') },
    { id: 'b', carrier: 'DPD', tracking_number: 'X2', dispatched_at: null },
    { id: 'e', carrier: 'DPD', tracking_number: '   ', dispatched_at: d('08:00:00') },
    { id: 'f', carrier: '', tracking_number: 'X3', dispatched_at: d('09:00:00') },
  ];
  assert.deepEqual(trackingToCopy(rows, new Set()).map((r) => [r.id, r.carrier, r.tracking_number]), [['a', 'InPost', 'X1'], ['f', 'nieznany', 'X3'], ['c', 'DPD', '0000123']]);
  assert.deepEqual(trackingToCopy(rows, new Set(['a', 'c', 'f'])), [], 'idempotent');
});
