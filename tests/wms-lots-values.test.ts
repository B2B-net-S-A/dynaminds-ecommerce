import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWmsMinor,
  wmsCostValue,
  wmsValueSummary,
  selectFifoLayers,
  type WmsFifoLayer,
} from '../server/wms-lots-values';
const row = (
  id: number,
  seq: string,
  available: number,
  cost: string | null,
  location = 'A',
): WmsFifoLayer => ({
  layer_id: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
  location,
  fifo_sequence: seq,
  available,
  unit_cost_minor: cost,
  currency: 'PLN',
});
test('exact costs beyond JavaScript safe integer preserve every minor unit', () => {
  assert.equal(parseWmsMinor('9007199254740993'), '9007199254740993');
  assert.deepEqual(wmsCostValue(3, '9007199254740993'), {
    known_minor: '27021597764222979',
    unknown_quantity: 0,
  });
  assert.equal(parseWmsMinor('9223372036854775807'), '9223372036854775807');
});
test('unknown opening cost is distinguished from deliberately known zero', () => {
  assert.deepEqual(wmsCostValue(5, null), { known_minor: '0', unknown_quantity: 5 });
  assert.deepEqual(wmsCostValue(5, '0'), { known_minor: '0', unknown_quantity: 0 });
  assert.deepEqual(
    wmsValueSummary(
      [
        { quantity: 5, unit_cost_minor: null, currency: 'PLN' },
        { quantity: 2, unit_cost_minor: '123', currency: 'PLN' },
      ],
      'PLN',
    ),
    {
      currency: 'PLN',
      quantity: '7',
      known_minor: '246',
      unknown_quantity: '5',
      known_quantity: '2',
    },
  );
});
test('fractional unsafe coerced and noncanonical monetary inputs are rejected', () => {
  for (const bad of [
    0,
    1,
    1.5,
    9007199254740993,
    '01',
    '-1',
    '+1',
    '1.0',
    '1e3',
    ' 1',
    '1 ',
    '',
    '9223372036854775808',
  ])
    assert.throws(() => parseWmsMinor(bad));
  for (const q of [-1, 0.5, NaN, Infinity, 2147483648]) assert.throws(() => wmsCostValue(q, '1'));
});
test('per-layer and aggregate int64 overflow reject the whole allocation', () => {
  assert.throws(() => wmsCostValue(2, '9223372036854775807'));
  assert.throws(() =>
    selectFifoLayers(
      [row(1, '1', 1, '5000000000000000000'), row(2, '2', 1, '5000000000000000000')],
      2,
    ),
  );
});
test('FIFO crosses old layers and splits bins without rewriting input or choosing cheaper stock', () => {
  const input = [row(3, '3', 20, '1'), row(2, '2', 4, '222'), row(1, '1', 2, '333')];
  const before = structuredClone(input);
  const picks = selectFifoLayers(input, 5);
  assert.deepEqual(
    picks.map((p) => [p.fifo_sequence, p.quantity]),
    [
      ['1', 2],
      ['2', 3],
    ],
  );
  assert.equal(wmsValueSummary(picks, 'PLN').known_minor, '1332');
  assert.deepEqual(input, before);
});
test('int64 FIFO sequence ordering and UTF8 bin ties are stable under input permutations', () => {
  const input = [
    row(2, '9007199254740993', 1, '20'),
    row(1, '9007199254740992', 1, '10', 'B'),
    row(1, '9007199254740992', 1, '10', 'A'),
  ];
  const expected = selectFifoLayers(input, 3);
  assert.deepEqual(
    expected.map((p) => p.location),
    ['A', 'B', 'A'],
  );
  assert.deepEqual(selectFifoLayers([...input].reverse(), 3), expected);
});
test('available rather than received quantity determines FIFO and shortage never returns a partial result', () => {
  assert.deepEqual(
    selectFifoLayers([row(1, '1', 0, '3'), row(2, '2', 2, '4')], 2).map((p) => p.fifo_sequence),
    ['2'],
  );
  assert.throws(() => selectFifoLayers([row(1, '1', 1, '3')], 2));
  assert.throws(() => selectFifoLayers([], 1));
  assert.throws(() => selectFifoLayers([row(1, '1', 1, '3')], 0));
});
test('mixed currency duplicate position invalid identity or order is rejected before choosing', () => {
  assert.throws(() => selectFifoLayers([row(1, '1', 1, '3'), row(1, '1', 1, '3')], 1));
  assert.throws(() =>
    selectFifoLayers([row(1, '1', 1, '3'), { ...row(2, '2', 1, '3'), currency: 'EUR' }], 1),
  );
  assert.throws(() => selectFifoLayers([{ ...row(1, '1', 1, '3'), layer_id: 'other' }], 1));
  assert.throws(() => selectFifoLayers([row(1, '0', 1, '3')], 1));
  assert.throws(() => selectFifoLayers([row(1, '1', 1, '3', 'A\u0000B')], 1));
});
test('valuation quantity totals are decimal strings and exceed int32 without loss', () => {
  assert.deepEqual(
    wmsValueSummary(
      [
        { quantity: 2147483647, unit_cost_minor: null, currency: 'PLN' },
        { quantity: 2147483647, unit_cost_minor: '1', currency: 'PLN' },
      ],
      'PLN',
    ),
    {
      currency: 'PLN',
      quantity: '4294967294',
      known_minor: '2147483647',
      unknown_quantity: '2147483647',
      known_quantity: '2147483647',
    },
  );
});
