import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Problem } from '../server/errors';
import {
  PACKING_MEASUREMENT_LIMITS,
  packingMeasurementsInput,
  projectPackingToInPostCourier,
  projectPackingToDpd,
  type PackingMeasurements,
} from '../server/packing-measurements';

const measured: PackingMeasurements = {
  weight_grams: 1370,
  length_mm: 380,
  width_mm: 200,
  height_mm: 100,
};
function rejects422(project: (input: unknown) => unknown, input: unknown, message?: RegExp) {
  assert.throws(
    () => project(input),
    (error: unknown) =>
      error instanceof Problem && error.status === 422 && (!message || message.test(error.message)),
  );
}

test('strict noncoercing measurement schema accepts exact physical-unit boundaries', () => {
  assert.deepEqual(PACKING_MEASUREMENT_LIMITS, {
    weight_grams: { min: 1, max: 1000000 },
    dimensions_mm: { min: 1, max: 3000 },
  });
  for (const input of [
    { weight_grams: 1, length_mm: 1, width_mm: 1, height_mm: 1 },
    { weight_grams: 1000000, length_mm: 3000, width_mm: 3000, height_mm: 3000 },
    measured,
  ])
    assert.deepEqual(packingMeasurementsInput.parse(input), input);
});

test('zero, negative, fractional, nonfinite and string values are never measurements', () => {
  for (const field of ['weight_grams', 'length_mm', 'width_mm', 'height_mm']) {
    const max = field === 'weight_grams' ? 1000000 : 3000;
    for (const value of [0, -1, 1.5, max + 1, '100', '', null, true, NaN, Infinity, -Infinity]) {
      const input = { ...measured, [field]: value };
      assert.equal(packingMeasurementsInput.safeParse(input).success, false, field + ':' + value);
      rejects422(projectPackingToInPostCourier, input, /Pomiar paczki/);
      rejects422(projectPackingToDpd, input, /Pomiar paczki/);
    }
  }
});

test('missing fields, extra fields and nonobject payloads fail instead of defaulting or stripping', () => {
  const inputs: unknown[] = [
    undefined,
    null,
    [],
    '1370',
    1370,
    {},
    { ...measured, template: 'small' },
  ];
  for (const field of Object.keys(measured)) {
    const incomplete: Record<string, unknown> = { ...measured };
    delete incomplete[field];
    inputs.push(incomplete);
  }
  for (const input of inputs) {
    assert.equal(packingMeasurementsInput.safeParse(input).success, false);
    rejects422(projectPackingToInPostCourier, input, /Pomiar paczki/);
    rejects422(projectPackingToDpd, input, /Pomiar paczki/);
  }
});

test('InPost courier keeps exact mm and g-to-kg values, including measurements DPD cannot represent', () => {
  assert.deepEqual(projectPackingToInPostCourier(measured), {
    weight: 1.37,
    dimensions: { length: 380, width: 200, height: 100 },
  });
  assert.deepEqual(
    projectPackingToInPostCourier({ ...measured, weight_grams: 1375, length_mm: 382 }),
    {
      weight: 1.375,
      dimensions: { length: 382, width: 200, height: 100 },
    },
  );
  assert.deepEqual(
    projectPackingToInPostCourier({ weight_grams: 1, length_mm: 1, width_mm: 1, height_mm: 1 }),
    {
      weight: 0.001,
      dimensions: { length: 1, width: 1, height: 1 },
    },
  );
});

test('InPost courier accepts 25 kg and exactly 2200 mm but rejects each distinct limit beyond it', () => {
  const boundary = { weight_grams: 25000, length_mm: 1200, width_mm: 500, height_mm: 500 };
  assert.deepEqual(projectPackingToInPostCourier(boundary), {
    weight: 25,
    dimensions: { length: 1200, width: 500, height: 500 },
  });
  rejects422(projectPackingToInPostCourier, { ...boundary, weight_grams: 25001 }, /25000 g/);
  rejects422(projectPackingToInPostCourier, { ...boundary, height_mm: 501 }, /sumę.*2200 mm/);
  for (const field of ['length_mm', 'width_mm', 'height_mm'])
    rejects422(
      projectPackingToInPostCourier,
      { ...measured, [field]: 1201 },
      /każdy wymiar.*1200 mm/,
    );
});

test('DPD converts only whole centimetres and 10g increments, with exact adapter boundaries', () => {
  assert.deepEqual(projectPackingToDpd(measured), {
    weight: 1.37,
    dimensions: { length: 38, width: 20, height: 10 },
  });
  assert.deepEqual(
    projectPackingToDpd({ weight_grams: 10, length_mm: 10, width_mm: 10, height_mm: 10 }),
    {
      weight: 0.01,
      dimensions: { length: 1, width: 1, height: 1 },
    },
  );
  // Our DPD adapter has individual side limits, not the InPost 2200 mm sum condition.
  assert.deepEqual(
    projectPackingToDpd({ weight_grams: 31500, length_mm: 1750, width_mm: 1750, height_mm: 1750 }),
    {
      weight: 31.5,
      dimensions: { length: 175, width: 175, height: 175 },
    },
  );
});

test('DPD rejects nonrepresentable 1375 g / 382 mm and out-of-range units without rounding', () => {
  rejects422(projectPackingToDpd, { ...measured, weight_grams: 1375 }, /krokach 10 g/);
  for (const field of ['length_mm', 'width_mm', 'height_mm']) {
    rejects422(projectPackingToDpd, { ...measured, [field]: 382 }, /pełnych cm/);
    rejects422(projectPackingToDpd, { ...measured, [field]: 1760 }, /1750 mm/);
    rejects422(projectPackingToDpd, { ...measured, [field]: 1 }, /pełnych cm/);
  }
  for (const weight_grams of [1, 9, 31501, 31510])
    rejects422(projectPackingToDpd, { ...measured, weight_grams }, /od 10 do 31500 g/);
});

test('projections and refusals preserve the historical measurement and independent output values', () => {
  const source = Object.freeze({ ...measured });
  const before = JSON.stringify(source);
  const inpost = projectPackingToInPostCourier(source),
    dpd = projectPackingToDpd(source);
  inpost.dimensions.length = 999;
  inpost.weight = 9;
  dpd.dimensions.width = 99;
  assert.equal(JSON.stringify(source), before);
  assert.deepEqual(projectPackingToInPostCourier(source), {
    weight: 1.37,
    dimensions: { length: 380, width: 200, height: 100 },
  });
  const unrepresentable = Object.freeze({ ...source, weight_grams: 1375, length_mm: 382 });
  const original = JSON.stringify(unrepresentable);
  rejects422(projectPackingToDpd, unrepresentable);
  assert.equal(JSON.stringify(unrepresentable), original);
  assert.deepEqual(packingMeasurementsInput.parse(unrepresentable), unrepresentable);
});
