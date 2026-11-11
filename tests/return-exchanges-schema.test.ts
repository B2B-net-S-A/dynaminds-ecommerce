import { test } from 'node:test';
import assert from 'node:assert/strict';
import { returnExchangePreviewInput, returnExchangeInput } from '../server/return-exchanges-schema';

const body = {
  version: 1,
  warehouse_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  note: 'Uszkodzona sztuka — wymiana bez przywrócenia do sprzedaży',
  items: [{ item_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', accepted: 1, restocked: 0 }],
};
const confirmed = {
  ...body,
  client_key: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  scope_hash: '1'.repeat(64),
  confirmed: true,
};

test('partial damaged exchange has zero restock and requires separate exact confirmation', () => {
  assert.equal(returnExchangePreviewInput.parse(body).items[0].restocked, 0);
  assert(returnExchangeInput.safeParse(confirmed).success);
  assert(!returnExchangeInput.safeParse(body).success);
  assert(!returnExchangeInput.safeParse({ ...confirmed, confirmed: false }).success);
  assert(!returnExchangeInput.safeParse({ ...confirmed, scope_hash: 'unbound' }).success);
});
test('public exchange cannot supply a private certificate, change pricing, or select a monetary remedy', () => {
  for (const field of [
    'replacementAdmissionId',
    'exchangeAdmissionId',
    'sourceTotals',
    'fulfillment_kind',
    'remedy',
    'total',
    'shipping_refund',
    'refund_amount',
    'actor_id',
    'api_key_id',
  ]) {
    assert(!returnExchangeInput.safeParse({ ...confirmed, [field]: field }).success, field);
    assert(!returnExchangePreviewInput.safeParse({ ...body, [field]: field }).success, field);
  }
});
test('duplicate commercial UUIDs are rejected even when textual case differs', () => {
  assert(
    !returnExchangePreviewInput.safeParse({
      ...body,
      items: [body.items[0], { ...body.items[0], item_id: body.items[0].item_id.toUpperCase() }],
    }).success,
  );
});
test('accepted/restocked quantities must be bounded integers and restock cannot exceed acceptance', () => {
  for (const invalid of [-1, 0.5, 100001, '1', null]) {
    assert(
      !returnExchangePreviewInput.safeParse({
        ...body,
        items: [{ ...body.items[0], accepted: invalid }],
      }).success,
    );
    assert(
      !returnExchangePreviewInput.safeParse({
        ...body,
        items: [{ ...body.items[0], restocked: invalid }],
      }).success,
    );
  }
  assert(
    !returnExchangePreviewInput.safeParse({ ...body, items: [{ ...body.items[0], restocked: 2 }] })
      .success,
  );
  assert(
    returnExchangePreviewInput.safeParse({ ...body, items: [{ ...body.items[0], restocked: 1 }] })
      .success,
  );
});
test('whole decision needs at least one accepted unit and a valid complete case/version scope', () => {
  assert(!returnExchangePreviewInput.safeParse({ ...body, items: [] }).success);
  assert(
    !returnExchangePreviewInput.safeParse({ ...body, items: [{ ...body.items[0], accepted: 0 }] })
      .success,
  );
  assert(!returnExchangePreviewInput.safeParse({ ...body, version: 0 }).success);
  assert(!returnExchangePreviewInput.safeParse({ ...body, warehouse_id: 'foreign-name' }).success);
});

test('a selected replacement is a canonical product UUID without client-supplied recipe or price', () => {
  const selected = {
    ...body.items[0],
    replacement_product_id: 'DDDDDDDD-DDDD-4DDD-8DDD-DDDDDDDDDDDD',
  };
  const parsed = returnExchangePreviewInput.parse({ ...body, items: [selected] });
  assert.equal(
    parsed.items[0].replacement_product_id,
    selected.replacement_product_id.toLowerCase(),
  );
  assert.equal(parsed.items[0].accepted, 1);
  assert(returnExchangeInput.safeParse({ ...confirmed, items: [selected] }).success);
  for (const field of [
    'replacement_quantity',
    'replacement_price',
    'replacement_components',
    'replacement_version',
  ])
    assert(
      !returnExchangePreviewInput.safeParse({ ...body, items: [{ ...selected, [field]: 1 }] })
        .success,
      field,
    );
  for (const value of ['', 'different-sku', null, 123])
    assert(
      !returnExchangePreviewInput.safeParse({
        ...body,
        items: [{ ...selected, replacement_product_id: value }],
      }).success,
    );
});

test('an unaccepted line cannot carry a selected replacement even when another line is accepted', () => {
  const unaccepted = {
    item_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    accepted: 0,
    restocked: 0,
    replacement_product_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  };
  assert(
    !returnExchangePreviewInput.safeParse({ ...body, items: [body.items[0], unaccepted] }).success,
  );
  const { replacement_product_id: _selected, ...physicalOnly } = unaccepted;
  assert(
    returnExchangePreviewInput.safeParse({ ...body, items: [body.items[0], physicalOnly] }).success,
  );
});
