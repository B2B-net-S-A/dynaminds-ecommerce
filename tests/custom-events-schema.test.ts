/** AUTO-07: a rule may listen to an own event `custom.<key>` and an action may raise one. No database. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { automationRuleInput, orderAction, ruleInput } from '../server/operation-schema';
import { customEventClientKey, customEventInput } from '../server/custom-events';

const rule = (trigger: string, actions: unknown[] = [{ type: 'add_note', note: 'x' }]) => ({ name: 'Reguła', trigger, actions });

test('a rule trigger is a known event or custom.<key>; anything else is refused', () => {
  for (const t of ['custom.vip_check', 'custom.ab', 'custom.a1_b2']) {
    assert.equal(automationRuleInput.parse(rule(t)).trigger, t);
    assert.equal(ruleInput.parse(rule(t)).trigger, t);
  }
  for (const t of ['custom.', 'custom.A', 'custom.1abc', 'custom.a', 'custom.' + 'a'.repeat(41), 'custom.a-b', 'order.unknown', 'customx.ab'])
    assert.equal(automationRuleInput.safeParse(rule(t)).success, false, t);
});

test('raise_event names an own key; a manual call may carry its idempotency key', () => {
  assert.deepEqual(orderAction.parse({ type: 'raise_event', event_key: 'vip_check' }), { type: 'raise_event', event_key: 'vip_check' });
  const k = '00000000-0000-4000-8000-000000000001';
  assert.equal((orderAction.parse({ type: 'raise_event', event_key: 'vip_check', client_key: k }) as { client_key?: string }).client_key, k);
  for (const bad of [{ type: 'raise_event' }, { type: 'raise_event', event_key: 'Vip' }, { type: 'raise_event', event_key: 'vip', client_key: 'x' }, { type: 'raise_event', event_key: 'vip', extra: 1 }])
    assert.equal(orderAction.safeParse(bad).success, false, JSON.stringify(bad));
});

test('the call key comes from the operation (rule, schedule, batch) or from the caller, never from nothing', () => {
  const run = '00000000-0000-4000-8000-0000000000aa', order = '00000000-0000-4000-8000-0000000000bb', key = '00000000-0000-4000-8000-0000000000cc';
  assert.deepEqual(customEventClientKey(order, { chain_id: 'c', depth: 1, trace: [], operation: { kind: 'rule', id: run, action_index: 2 } }, undefined),
    { source: 'rule', client_key: `rule:${run}:2:${order}`, operation_id: run });
  assert.deepEqual(customEventClientKey(order, { chain_id: 'c', depth: 0, trace: [], operation: { kind: 'batch', id: run, action_index: 0 } }, key),
    { source: 'batch', client_key: `batch:${run}:0:${order}`, operation_id: run }, 'the operation wins over a stored key');
  assert.deepEqual(customEventClientKey(order, undefined, key, 'api'), { source: 'api', client_key: 'api:' + key, operation_id: null });
  assert.deepEqual(customEventClientKey(order, undefined, key), { source: 'ui', client_key: 'ui:' + key, operation_id: null });
  assert.throws(() => customEventClientKey(order, undefined, undefined), (e: any) => e.status === 422 && /klucz/i.test(e.message));
  const preview = customEventClientKey(order, { chain_id: 'preview', depth: 0, trace: [], preview: true }, undefined);
  assert.match(preview.client_key, /^preview:[0-9a-f-]{36}$/);
});

test('a definition has an immutable lower-case key, a name and an optional description', () => {
  assert.deepEqual(customEventInput.parse({ key: 'vip_check', name: 'Sprawdź VIP' }), { key: 'vip_check', name: 'Sprawdź VIP', description: '', active: true });
  for (const bad of [{ key: 'VIP', name: 'ab' }, { key: 'vip', name: 'a' }, { key: 'vip', name: 'ok', description: 'x'.repeat(501) }])
    assert.equal(customEventInput.safeParse(bad).success, false, JSON.stringify(bad));
});
