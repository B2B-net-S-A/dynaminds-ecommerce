/** REPRICE-004 (manual override) and REPRICE-005/006 (channel result of a scheduled run), migration 247.
 * Pure rules only: how an override changes a computed row, the override input, and how an offer plan
 * becomes the channel result of a run row. No database. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRepricingOverride, overrideInput, overrideRowKey } from '../server/repricing-overrides';
import { channelOutcome, summarizeChannel, CHANNEL_STATES } from '../server/repricing-channel';

const product = { id: 'p1', sku: 'SKU-1', version: 3, vat: 23, active: true, kind: 'simple' };
const computed = { product_id: 'p1', sku: 'SKU-1', product_version: 3, vat: 23, current_price: 12000, strategy: 'competitor', proposed_price: 9999, floor: 9000, state: 'change', reason: 'Cena konkurencji z ochroną marży', current_source: 'list' };
const exclude = { id: 'o1', mode: 'exclude' as const, fixed_price: null, reason: 'Promocja producenta do 31.10', created_at: '2026-10-27T10:00:00.000Z', created_by: 'u1' };
const fixed = { id: 'o2', mode: 'fixed' as const, fixed_price: 11990, reason: 'Cena ustalona z hurtownią', created_at: '2026-10-27T10:00:00.000Z', created_by: 'u1' };

test('no override: the computed row is returned unchanged (same object contents)', () => {
  assert.deepEqual(applyRepricingOverride(computed, null, product), computed);
});

test('exclusion keeps the current price: state override, nothing to write, the reason and author in the row', () => {
  const r = applyRepricingOverride(computed, exclude, product);
  assert.equal(r.state, 'override');
  assert.equal(r.proposed_price, 12000);
  assert.equal(r.computed_price, 9999, 'the automatic price stays visible for the operator');
  assert.deepEqual(r.override, { id: 'o1', mode: 'exclude', fixed_price: null, reason: exclude.reason, created_at: exclude.created_at, created_by: 'u1' });
  assert.match(r.reason, /Wykluczone ręcznie: Promocja producenta/);
  // An exclusion also lifts a block: the SKU is deliberately not repriced.
  const blocked = { ...computed, proposed_price: null, state: 'blocked', reason: 'Brak obserwacji konkurencji' };
  assert.equal(applyRepricingOverride(blocked, exclude, product).state, 'override');
  // Without a current price there is nothing to keep: still not written.
  const r2 = applyRepricingOverride({ ...computed, current_price: null }, exclude, product);
  assert.equal(r2.state, 'override');
  assert.equal(r2.proposed_price, null);
});

test('fixed price replaces the automatic one; equal to current is unchanged; below the floor is marked, never silently raised', () => {
  const r = applyRepricingOverride(computed, fixed, product);
  assert.equal(r.state, 'change');
  assert.equal(r.proposed_price, 11990);
  assert.equal(r.computed_price, 9999);
  assert.equal(r.below_floor, false);
  assert.match(r.reason, /Ręczna cena: Cena ustalona/);
  assert.equal(applyRepricingOverride({ ...computed, current_price: 11990 }, fixed, product).state, 'unchanged');
  const low = applyRepricingOverride(computed, { ...fixed, fixed_price: 5000 }, product);
  assert.equal(low.proposed_price, 5000);
  assert.equal(low.below_floor, true);
  // A fixed price is written even when the automatic calculation was blocked (no cost, stale observation).
  const unblocked = applyRepricingOverride({ ...computed, proposed_price: null, floor: null, state: 'blocked', reason: 'Brak jawnego kosztu' }, fixed, product);
  assert.equal(unblocked.state, 'change');
  assert.equal(unblocked.below_floor, false);
});

test('an inactive product or a variant group stays blocked whatever the override says', () => {
  for (const p of [{ ...product, active: false }, { ...product, kind: 'group' }]) {
    const blocked = { ...computed, proposed_price: null, state: 'blocked', reason: 'Produkt nieaktywny lub grupa wariantów' };
    assert.equal(applyRepricingOverride(blocked, fixed, p).state, 'blocked');
    assert.equal(applyRepricingOverride(blocked, exclude, p).state, 'blocked');
  }
});

test('override input: fixed needs a price in range, exclusion must not carry one, reason 3–500 characters', () => {
  const base = { product_id: '0b0d5c9e-6b0e-4b8a-9b50-2f1f6b7f9a10', reason: 'Umowa z dostawcą', replaces: null };
  assert.equal(overrideInput.safeParse({ ...base, mode: 'exclude' }).success, true);
  assert.equal(overrideInput.safeParse({ ...base, mode: 'exclude', fixed_price: 100 }).success, false);
  assert.equal(overrideInput.safeParse({ ...base, mode: 'fixed' }).success, false);
  assert.equal(overrideInput.safeParse({ ...base, mode: 'fixed', fixed_price: 100000001 }).success, false);
  assert.equal(overrideInput.safeParse({ ...base, mode: 'fixed', fixed_price: -1 }).success, false);
  assert.equal(overrideInput.safeParse({ ...base, mode: 'fixed', fixed_price: 0 }).success, true);
  assert.equal(overrideInput.safeParse({ ...base, mode: 'exclude', reason: 'ab' }).success, false);
  assert.equal(overrideInput.safeParse({ ...base, mode: 'exclude', reason: 'x'.repeat(501) }).success, false);
  assert.equal(overrideInput.safeParse({ ...base, mode: 'exclude', extra: 1 }).success, false);
  assert.equal(overrideRowKey(fixed), 'o2');
});

const expected = { price: 11990, currency: 'PLN', applied_at: '2026-10-27T10:00:00.000Z' };
const plan = (over: any = {}) => ({ id: 'plan1', state: 'done', phase: 'done', created_at: '2026-10-27T10:05:00.000Z', error: null,
  local_snapshot: { price: 11990, currency: 'PLN' }, result: { desired_applied: true, local_changed: false }, ...over });

test('channel outcome: waiting, sent, acknowledged, mismatch, failed, superseded', () => {
  assert.deepEqual(channelOutcome(expected, null), { status: 'pending', plan_id: null, remote_price: null, error: null });
  assert.equal(channelOutcome(expected, plan({ state: 'preview', phase: 'ready' })).status, 'pending');
  assert.equal(channelOutcome(expected, plan({ state: 'queued', phase: 'ready', result: null })).status, 'sent');
  assert.equal(channelOutcome(expected, plan({ state: 'failed', phase: 'write_started', result: null, error: 'timeout' })).status, 'sent', 'uncertain write is not a failure yet');
  assert.deepEqual(channelOutcome(expected, plan()), { status: 'acknowledged', plan_id: 'plan1', remote_price: 11990, error: null });
  assert.equal(channelOutcome(expected, plan({ result: { unchanged: true, desired_applied: true, local_changed: false } })).status, 'acknowledged');
  const m = channelOutcome(expected, plan({ result: { desired_applied: false, local_changed: false } }));
  assert.equal(m.status, 'mismatch');
  assert.equal(m.remote_price, null);
  assert.match(m.error!, /Kanał nie potwierdził ceny/);
  const f = channelOutcome(expected, plan({ state: 'conflict', phase: 'ready', result: null, error: 'Oferta zmieniona w kanale' }));
  assert.deepEqual(f, { status: 'failed', plan_id: 'plan1', remote_price: null, error: 'Oferta zmieniona w kanale' });
  assert.equal(channelOutcome(expected, plan({ state: 'failed', phase: 'ready', result: null, error: null })).error, 'Zapis oferty nie powiódł się');
  const s = channelOutcome(expected, plan({ local_snapshot: { price: 12990, currency: 'PLN' } }));
  assert.equal(s.status, 'superseded');
  assert.equal(channelOutcome(expected, plan({ local_snapshot: { price: 11990, currency: 'EUR' } })).status, 'superseded');
  assert.equal(channelOutcome(expected, plan({ created_at: '2026-10-27T09:59:59.999Z' })).status, 'pending', 'a plan older than the price write is not its result');
  for (const s of ['pending', 'sent', 'acknowledged', 'mismatch', 'failed', 'superseded']) assert(CHANNEL_STATES.includes(s as any));
});

test('summary per run: counts per state, open = pending + sent, and an empty run has no channel', () => {
  const sum = summarizeChannel([{ status: 'acknowledged', n: 2 }, { status: 'sent', n: 1 }, { status: 'mismatch', n: 1 }, { status: 'pending', n: 3 }]);
  assert.deepEqual(sum, { total: 7, open: 4, pending: 3, sent: 1, acknowledged: 2, mismatch: 1, failed: 0, superseded: 0 });
  assert.equal(summarizeChannel([]), null);
});
