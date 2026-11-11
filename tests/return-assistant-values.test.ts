import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { deriveReturnAssistantDecision, returnAssistantDraftInput } from '../server/return-assistant-schema';

test('split inspection preserves separate original lines, whole quantities and acceptance outside sale stock', () => {
  const a = randomUUID(), b = randomUUID();
  const result = deriveReturnAssistantDecision(
    [{ item_id: a, requested: 3 }, { item_id: b, requested: 2 }],
    [{ item_id: b, quantity: 1 }, { item_id: a, quantity: 2 }],
    [
      { part_id: randomUUID(), item_id: b, status: 'hold', quantity: 1 },
      { part_id: randomUUID(), item_id: a, status: 'sale', quantity: 1 },
      { part_id: randomUUID(), item_id: a, status: 'reject', quantity: 1 },
      { part_id: randomUUID(), item_id: b, status: 'reject', quantity: 1 },
      { part_id: randomUUID(), item_id: a, status: 'hold', quantity: 1 },
    ],
  );
  assert.deepEqual(result.find(i => i.item_id === a), { item_id: a, accepted: 2, restocked: 1 });
  assert.deepEqual(result.find(i => i.item_id === b), { item_id: b, accepted: 1, restocked: 0 });
});

test('full rejection needs no invented inspection or accepted stock, including large grouped quantities', () => {
  const id = randomUUID();
  assert.deepEqual(deriveReturnAssistantDecision([{ item_id: id, requested: 100000 }], [],
    [{ part_id: randomUUID(), item_id: id, status: 'reject', quantity: 100000 }]),
  [{ item_id: id, accepted: 0, restocked: 0 }]);
});

test('partial drafts may be saved but incomplete or uninspected quantities cannot be approved', () => {
  const id = randomUUID(), lines = [{ item_id: id, requested: 3 }];
  const parts = [{ part_id: randomUUID(), item_id: id, status: 'sale' as const, quantity: 1 }];
  assert.deepEqual(deriveReturnAssistantDecision(lines, [{ item_id: id, quantity: 1 }], parts, false),
    [{ item_id: id, accepted: 1, restocked: 1 }]);
  assert.throws(() => deriveReturnAssistantDecision(lines, [{ item_id: id, quantity: 1 }], parts));
  assert.throws(() => deriveReturnAssistantDecision(lines, [], parts, false));
  assert.throws(() => deriveReturnAssistantDecision(lines, [{ item_id: id, quantity: 3 }],
    [{ ...parts[0], quantity: 4 }], false));
});

test('foreign lines and duplicate split identifiers cannot enter acceptance', () => {
  const id = randomUUID(), part = { part_id: randomUUID(), item_id: id, status: 'reject' as const, quantity: 1 };
  assert.throws(() => deriveReturnAssistantDecision([{ item_id: id, requested: 2 }], [], [part, part]));
  assert.throws(() => deriveReturnAssistantDecision([{ item_id: id, requested: 1 }], [],
    [{ ...part, item_id: randomUUID() }]));
});

test('draft wire refuses fractional units, duplicated parts and injected core acceptance fields', () => {
  const base = { client_key: randomUUID(), version: '1', lease_token: randomUUID(),
    note: 'Kontrola zwrotu', shipping_refund: 0, parts: [
      { part_id: randomUUID(), item_id: randomUUID(), status: 'sale', quantity: 1 },
    ] };
  assert(returnAssistantDraftInput.safeParse(base).success);
  assert(!returnAssistantDraftInput.safeParse({ ...base, parts: [{ ...base.parts[0], quantity: 0.5 }] }).success);
  assert(!returnAssistantDraftInput.safeParse({ ...base, parts: [base.parts[0], base.parts[0]] }).success);
  assert(!returnAssistantDraftInput.safeParse({ ...base, accepted: 999, restocked: 999 }).success);
});
