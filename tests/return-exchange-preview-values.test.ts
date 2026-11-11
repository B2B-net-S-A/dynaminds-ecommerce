import { test } from 'node:test';
import assert from 'node:assert/strict';
import { completeReturnExchangePreview } from '../server/return-exchange-preview-values';

const frame = () => ({
  public: {
    warehouse_id: 'SECOND',
    scope_hash: 'bound-hash',
    rows: [
      {
        restocked: 1,
        components: [
          { product_id: 'A', quantity: 1 },
          { product_id: 'B', quantity: 2 },
        ],
      },
    ],
    stock: [
      { product_id: 'A', sku: 'A' },
      { product_id: 'B', sku: 'B' },
    ],
  },
  snapshot: {
    return: { warehouse_id: 'MAIN', internal_actor: 'PRIVATE' },
    physical: {
      stock: [
        { warehouse_id: 'MAIN', product_id: 'A', on_hand: 5, reserved: 2, version: '3' },
        { warehouse_id: 'SECOND', product_id: 'A', on_hand: 99, reserved: 50, version: '8' },
      ],
    },
  },
});
test('bundle return changes MAIN stock separately from SECOND reservation and omits private frame', () => {
  const f = frame(),
    result = completeReturnExchangePreview(f);
  assert.deepEqual(result.return_stock, [
    {
      product_id: 'A',
      sku: 'A',
      on_hand: 5,
      reserved: 2,
      available: 3,
      version: '3',
      return_quantity: 1,
      replacement_quantity: 0,
      after_on_hand: 6,
      after_reserved: 2,
      after_available: 4,
    },
    {
      product_id: 'B',
      sku: 'B',
      on_hand: 0,
      reserved: 0,
      available: 0,
      version: null,
      return_quantity: 2,
      replacement_quantity: 0,
      after_on_hand: 2,
      after_reserved: 0,
      after_available: 2,
    },
  ]);
  assert.equal(result.scope_hash, 'bound-hash');
  assert.deepEqual(result.stock, f.public.stock);
  assert(!JSON.stringify(result).includes('PRIVATE'));
  assert.equal(result.snapshot, undefined);
});
test('same warehouse keeps the existing combined preview without duplicating receipt quantity', () => {
  const f = frame();
  f.public.warehouse_id = 'MAIN';
  const result = completeReturnExchangePreview(f);
  assert.deepEqual(result.return_stock, []);
  assert.deepEqual(result.stock, f.public.stock);
});
test('source-warehouse overflow refuses preview before a separately stocked replacement can be approved', () => {
  const f = frame();
  f.snapshot.physical.stock[0].on_hand = 2147483647;
  assert.throws(() => completeReturnExchangePreview(f), /limit stanu/);
});
test('different replacement recipe never adds its components to the source receipt preview', () => {
  const f: any = frame();
  f.public.rows[0].replacement = {
    product_id: 'NEW-BUNDLE',
    components: [
      { product_id: 'C', quantity: 3 },
      { product_id: 'A', quantity: 2 },
    ],
  };
  f.public.stock.push({ product_id: 'C', sku: 'C' });
  f.snapshot.physical.stock.push({
    warehouse_id: 'MAIN',
    product_id: 'C',
    on_hand: 50,
    reserved: 0,
  });
  const result = completeReturnExchangePreview(f);
  assert.deepEqual(
    result.return_stock.map((p: any) => [p.product_id, p.return_quantity]),
    [
      ['A', 1],
      ['B', 2],
    ],
  );
  assert.equal(result.return_stock.find((p: any) => p.product_id === 'A').after_on_hand, 6);
  assert.deepEqual(result.stock, f.public.stock);
  assert.deepEqual(result.rows[0].replacement, f.public.rows[0].replacement);
});
test('original products without a restock are omitted from the second warehouse receipt table', () => {
  const f = frame();
  f.public.rows[0].restocked = 0;
  assert.deepEqual(completeReturnExchangePreview(f).return_stock, []);
});
test('a missing original component in the locked public scope refuses the source receipt preview', () => {
  const f = frame();
  f.public.stock = f.public.stock.filter((p) => p.product_id !== 'B');
  assert.throws(() => completeReturnExchangePreview(f), /Brak pełnego podglądu/);
});
