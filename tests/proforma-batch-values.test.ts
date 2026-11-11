import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { proformaRequestHash } from '../server/proforma-values';
import {
  proformaBatchPreviewInput,
  proformaBatchIssueInput,
  proformaBatchChildKey,
} from '../server/proforma-batch-values';

const request = () => ({
  client_key: randomUUID(),
  series_id: randomUUID(),
  shipping_vat: 8,
  orders: Array.from({ length: 3 }, () => ({ order_id: randomUUID(), order_version: '1' })),
});
test('batch selection is canonical and rejects duplicates after UUID normalization', () => {
  const a = request();
  const one = proformaBatchPreviewInput.parse(a);
  const two = proformaBatchPreviewInput.parse({
    ...a,
    orders: [...a.orders].reverse().map((r) => ({ ...r, order_id: r.order_id.toUpperCase() })),
  });
  assert.deepEqual(one, two);
  assert.equal(
    proformaBatchPreviewInput.safeParse({
      ...a,
      orders: [a.orders[0], { ...a.orders[0], order_id: a.orders[0].order_id.toUpperCase() }],
    }).success,
    false,
  );
});
test('batch selection includes exactly 1–50 explicit orders and rejects caller-owned child data', () => {
  const a = request();
  for (const length of [0, 51])
    assert.equal(
      proformaBatchPreviewInput.safeParse({
        ...a,
        orders: Array.from({ length }, () => ({ order_id: randomUUID(), order_version: '1' })),
      }).success,
      false,
    );
  assert.equal(
    proformaBatchPreviewInput.safeParse({
      ...a,
      orders: Array.from({ length: 50 }, () => ({ order_id: randomUUID(), order_version: '1' })),
    }).success,
    true,
  );
  assert.equal(
    proformaBatchPreviewInput.safeParse({ ...a, actor_id: randomUUID() }).success,
    false,
  );
  assert.equal(
    proformaBatchPreviewInput.safeParse({
      ...a,
      orders: [{ ...a.orders[0], child_key: randomUUID() }],
    }).success,
    false,
  );
});
test('every order version is validated without throwing a BigInt parsing error', () => {
  const a = request();
  for (const order_version of ['abc', '1.5', '01', '0', '9223372036854775808']) {
    assert.equal(
      proformaBatchPreviewInput.safeParse({
        ...a,
        orders: [a.orders[0], { ...a.orders[1], order_version }],
      }).success,
      false,
    );
  }
});
test('batch consent requires the reviewed scope and both explicit confirmations', () => {
  const a = {
    client_key: randomUUID(),
    scope_hash: 'a'.repeat(64),
    confirmed: true,
    local_only: true,
  };
  assert.equal(proformaBatchIssueInput.safeParse(a).success, true);
  for (const invalid of [
    { confirmed: false },
    { local_only: false },
    { scope_hash: 'A'.repeat(64) },
    { document_ids: [] },
  ])
    assert.equal(proformaBatchIssueInput.safeParse({ ...a, ...invalid }).success, false);
});
test('accepted batch hash changes with one version or principal; child keys cannot cross parents or operations', () => {
  const a = proformaBatchPreviewInput.parse(request());
  const h = (body: unknown, actor = 'u', key: string | null = null) =>
    proformaRequestHash('t', actor, key, 'batch.preview', null, body);
  assert.equal(h(a), h({ ...a, orders: [...a.orders] }));
  assert.notEqual(
    h(a),
    h({ ...a, orders: a.orders.map((r, i) => (i === 1 ? { ...r, order_version: '2' } : r)) }),
  );
  assert.notEqual(h(a), h(a, 'other'));
  assert.notEqual(h(a), h(a, 'u', 'api-key'));
  const parent = randomUUID(),
    other = randomUUID(),
    order = randomUUID();
  const k = proformaBatchChildKey(parent, order, 'preview');
  assert.match(k, /^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-a[a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(k, proformaBatchChildKey(parent.toUpperCase(), order.toUpperCase(), 'preview'));
  assert.notEqual(k, proformaBatchChildKey(other, order, 'preview'));
  assert.notEqual(k, proformaBatchChildKey(parent, order, 'issue'));
});
