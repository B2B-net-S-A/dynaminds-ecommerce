import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertLegacyReturnAssistantPayload } from '../server/return-assistant-protocol';

for (const payload of [
  { snapshot: { protocol: 'destinations_v1', plan: { private_fragment_effects: [{ unit_cost_minor: '123456' }] } } },
  { plan: { protocol: 'destinations_v1' } },
  { snapshot: { plan: { protocol: 'destinations_v1' } } },
  { planner_source: { wms: { issue_fragments: [{ unit_cost_minor: '123456' }] } } },
]) test('shared ledger typed payload stops before any legacy spread', () => {
  const before = structuredClone(payload);
  assert.throws(() => assertLegacyReturnAssistantPayload(payload), (e: any) =>
    e.status === 409 && !e.message.includes('123456'));
  assert.deepEqual(payload, before);
});

test('ordinary139 custody payload remains exact and readable', () => {
  const payload = { action: 'receive', receive_input: { version: 1 }, snapshot: {
    session: { version: '4' }, source: { stock: [], issue_fragments: [{ unit_cost_minor: '0' }] } } };
  const before = structuredClone(payload); assertLegacyReturnAssistantPayload(payload); assert.deepEqual(payload, before);
});
