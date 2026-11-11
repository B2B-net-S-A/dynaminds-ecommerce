import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allocationPreviewInput,
  allocationExecuteInput,
  allocationOptionsQuery,
  paymentImportAllocationTotals,
} from '../server/payment-import-allocation-values';

const first = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const second = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const body = {
  client_key: first,
  source_preview_id: second,
  source_row_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  source_version: 0,
  allocations: [
    { order_id: first, amount_minor: 10000, fee_minor: 0 },
    { order_id: second, amount_minor: 20000, fee_minor: 0 },
  ],
  unallocated_minor: 5000,
  unallocated_fee_minor: 0,
  reason: 'Jedna wpłata za dwa zamówienia i jawna reszta',
};

test('aggregate bank receipt keeps the pending remainder separate from posted money', () => {
  const total = paymentImportAllocationTotals(allocationPreviewInput.parse(body));
  assert.equal(total.amount_minor, 30000n);
  assert.equal(total.fee_minor, 0n);
  assert.equal(total.unallocated_minor, 5000n);
  assert.equal(total.amount_minor + total.unallocated_minor, 35000n);
});

test('COD settlement conserves cash and fee independently, including a deferred fee', () => {
  const total = paymentImportAllocationTotals(
    allocationPreviewInput.parse({
      ...body,
      allocations: [
        { order_id: first, shipment_id: first, amount_minor: 9800, fee_minor: 200 },
        { order_id: second, shipment_id: second, amount_minor: 19400, fee_minor: 400 },
      ],
      unallocated_minor: 1000,
      unallocated_fee_minor: 100,
    }),
  );
  assert.equal(total.amount_minor + total.unallocated_minor, 30200n);
  assert.equal(total.fee_minor + total.unallocated_fee_minor, 700n);
  assert.equal(
    total.amount_minor + total.fee_minor + total.unallocated_minor + total.unallocated_fee_minor,
    30900n,
  );
});

test('batch sums remain exact above the single-entry int32 range', () => {
  const total = paymentImportAllocationTotals(
    allocationPreviewInput.parse({
      ...body,
      allocations: body.allocations.map((r) => ({ ...r, amount_minor: 2147483647 })),
      unallocated_minor: 0,
    }),
  );
  assert.equal(total.amount_minor, 4294967294n);
});

test('minor amounts reject floating values, coercion, negatives and entry overflow', () => {
  for (const invalid of [-1, 0.1, '10000', null, 2147483648, Number.NaN, Infinity]) {
    assert(!allocationPreviewInput.safeParse({ ...body, unallocated_minor: invalid }).success);
    for (const field of ['amount_minor', 'fee_minor'])
      assert(
        !allocationPreviewInput.safeParse({
          ...body,
          allocations: [{ ...body.allocations[0], [field]: invalid }],
        }).success,
        field + ':' + invalid,
      );
  }
});

test('a target cannot be posted twice under UUID case variants; separate shipments remain distinct', () => {
  assert(
    !allocationPreviewInput.safeParse({
      ...body,
      allocations: [body.allocations[0], { ...body.allocations[0], order_id: first.toUpperCase() }],
    }).success,
  );
  assert(
    allocationPreviewInput.safeParse({
      ...body,
      allocations: [
        { ...body.allocations[0], shipment_id: first },
        { ...body.allocations[0], shipment_id: second },
      ],
    }).success,
  );
});

test('empty targets and an all-zero target cannot silently consume the transaction', () => {
  assert(!allocationPreviewInput.safeParse({ ...body, allocations: [] }).success);
  assert(
    !allocationPreviewInput.safeParse({
      ...body,
      allocations: [{ order_id: first, amount_minor: 0, fee_minor: 0 }],
    }).success,
  );
  assert(
    !allocationPreviewInput.safeParse({
      ...body,
      allocations: Array.from({ length: 101 }, (_, i) => ({
        order_id: `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`,
        amount_minor: 1,
        fee_minor: 0,
      })),
    }).success,
  );
});

test('confirmation must bind the exact review and cannot grant privileged execution fields', () => {
  const execute = {
    client_key: first,
    version: 1,
    scope_hash: 'a'.repeat(64),
    confirmed: true,
    local_ledger_only: true,
  };
  assert(allocationExecuteInput.safeParse(execute).success);
  for (const edit of [
    { confirmed: false },
    { local_ledger_only: false },
    { scope_hash: 'unbound' },
    { version: 2 },
    { actor_id: first },
    { source_version: 2 },
  ])
    assert(!allocationExecuteInput.safeParse({ ...execute, ...edit }).success);
  for (const field of [
    'tenant_id',
    'entry_id',
    'api_key_id',
    'economic_key',
    'ledger_kind',
    'snapshot',
  ])
    assert(!allocationPreviewInput.safeParse({ ...body, [field]: first }).success, field);
});

test('a source read requires both immutable source IDs and continuation requires an integer CAS', () => {
  assert(allocationOptionsQuery.safeParse({}).success);
  assert(!allocationOptionsQuery.safeParse({ source_preview_id: first }).success);
  assert(!allocationOptionsQuery.safeParse({ source_row_id: second }).success);
  assert(
    allocationOptionsQuery.safeParse({ source_preview_id: first, source_row_id: second }).success,
  );
  for (const invalid of [-1, 0.5, '1', 2147483647])
    assert(!allocationPreviewInput.safeParse({ ...body, source_version: invalid }).success);
  assert(allocationPreviewInput.safeParse({ ...body, source_version: 1 }).success);
});
