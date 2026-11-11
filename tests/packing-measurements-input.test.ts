import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  packingUnitText,
  validatePackingMeasurementsDraft,
  type PackingMeasurementsDraft,
} from '../web/packing-measurements-input';
import {
  packingMeasurementsInput,
  projectPackingToDpd,
  projectPackingToInPostCourier,
} from '../server/packing-measurements';

const draft: PackingMeasurementsDraft = {
  weight_kg: '1,375',
  length_cm: '38,2',
  width_cm: '20',
  height_cm: '10.0',
};

test('Polish decimal input remains exact g/mm through the strict server contract', () => {
  const frozen = Object.freeze({ ...draft });
  const parsed = validatePackingMeasurementsDraft(frozen);
  assert.deepEqual(parsed.errors, {});
  assert.deepEqual(parsed.measurements, {
    weight_grams: 1375,
    length_mm: 382,
    width_mm: 200,
    height_mm: 100,
  });
  assert.deepEqual(packingMeasurementsInput.parse(parsed.measurements), parsed.measurements);
  assert.equal(projectPackingToInPostCourier(parsed.measurements).weight, 1.375);
  assert.throws(() => projectPackingToDpd(parsed.measurements));
  assert.deepEqual(frozen, draft);
});

test('each missing field blocks the whole measured parcel instead of defaulting values', () => {
  for (const field of Object.keys(draft) as (keyof PackingMeasurementsDraft)[]) {
    const result = validatePackingMeasurementsDraft({ ...draft, [field]: '' });
    assert.equal(result.measurements, null);
    assert.deepEqual(Object.keys(result.errors), [field]);
    assert.match(result.errors[field]!, /rzeczywisty pomiar/);
  }
});

test('invalid text and surplus precision never round or normalize into an accepted measurement', () => {
  for (const field of Object.keys(draft) as (keyof PackingMeasurementsDraft)[]) {
    for (const raw of [
      '0',
      '-1',
      '+1',
      ' 1',
      '1 ',
      '1\n',
      '1e1',
      'NaN',
      'Infinity',
      '01',
      '1,',
      '1,2.3',
    ]) {
      const result = validatePackingMeasurementsDraft({ ...draft, [field]: raw });
      assert.equal(result.measurements, null, field + ':' + JSON.stringify(raw));
      assert(result.errors[field]);
    }
    const tooPrecise = field === 'weight_kg' ? '1.0001' : '1.01';
    assert.equal(
      validatePackingMeasurementsDraft({ ...draft, [field]: tooPrecise }).measurements,
      null,
    );
  }
});

test('minimum and maximum g/mm round trip through displayed units without changing integers', () => {
  for (const weight of [1, 1001, 1370, 25000, 31500, 1000000]) {
    for (const size of [1, 10, 382, 1750, 3000]) {
      const result = validatePackingMeasurementsDraft({
        weight_kg: packingUnitText(weight, 3),
        length_cm: packingUnitText(size, 1),
        width_cm: packingUnitText(size, 1),
        height_cm: packingUnitText(size, 1),
      });
      assert.deepEqual(result.measurements, {
        weight_grams: weight,
        length_mm: size,
        width_mm: size,
        height_mm: size,
      });
      assert.deepEqual(packingMeasurementsInput.parse(result.measurements), result.measurements);
    }
  }
  for (const [field, raw] of [
    ['weight_kg', '1000.001'],
    ['length_cm', '300.1'],
    ['width_cm', '300.1'],
    ['height_cm', '300.1'],
  ] as const)
    assert.equal(validatePackingMeasurementsDraft({ ...draft, [field]: raw }).measurements, null);
});

test('exact DPD-compatible measured draft reaches kg/cm without altering the original draft', () => {
  const source = Object.freeze({ ...draft, weight_kg: '1.370', length_cm: '38.0' });
  const result = validatePackingMeasurementsDraft(source);
  assert.deepEqual(projectPackingToDpd(result.measurements), {
    weight: 1.37,
    dimensions: { length: 38, width: 20, height: 10 },
  });
  assert.equal(source.weight_kg, '1.370');
  assert.equal(source.length_cm, '38.0');
});
