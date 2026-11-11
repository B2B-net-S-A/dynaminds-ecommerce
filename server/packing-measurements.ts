import { z } from 'zod';
import { ensure, Problem } from './errors';

export const PACKING_MEASUREMENT_LIMITS = {
  weight_grams: { min: 1, max: 1000000 },
  dimensions_mm: { min: 1, max: 3000 },
} as const;

const dimension = z
  .number()
  .int()
  .min(PACKING_MEASUREMENT_LIMITS.dimensions_mm.min)
  .max(PACKING_MEASUREMENT_LIMITS.dimensions_mm.max);

export const packingMeasurementsInput = z.strictObject({
  weight_grams: z
    .number()
    .int()
    .min(PACKING_MEASUREMENT_LIMITS.weight_grams.min)
    .max(PACKING_MEASUREMENT_LIMITS.weight_grams.max),
  length_mm: dimension,
  width_mm: dimension,
  height_mm: dimension,
});

export type PackingMeasurements = z.infer<typeof packingMeasurementsInput>;

function measurements(input: unknown): PackingMeasurements {
  const parsed = packingMeasurementsInput.safeParse(input);
  if (!parsed.success)
    throw new Problem(
      422,
      'Pomiar paczki wymaga całkowitej masy 1–1000000 g i trzech wymiarów 1–3000 mm, bez dodatkowych pól',
    );
  return parsed.data;
}

// Projection of measured g/mm into our existing InPost courier adapter's kg/mm.
// These are adapter constraints, not a complete carrier/service eligibility check.
export function projectPackingToInPostCourier(input: unknown) {
  const m = measurements(input);
  ensure(m.weight_grams <= 25000, 422, 'Adapter InPost Courier dopuszcza masę do 25000 g');
  ensure(
    [m.length_mm, m.width_mm, m.height_mm].every((v) => v <= 1200),
    422,
    'Adapter InPost Courier dopuszcza każdy wymiar do 1200 mm',
  );
  ensure(
    m.length_mm + m.width_mm + m.height_mm <= 2200,
    422,
    'Adapter InPost Courier dopuszcza sumę wymiarów do 2200 mm',
  );
  return {
    weight: m.weight_grams / 1000,
    dimensions: { length: m.length_mm, width: m.width_mm, height: m.height_mm },
  };
}

// Projection of measured g/mm into our existing DPD adapter's kg/cm.
// Divisibility proves representability before division; no rounding of the measurement.
export function projectPackingToDpd(input: unknown) {
  const m = measurements(input);
  ensure(
    m.weight_grams >= 10 && m.weight_grams <= 31500,
    422,
    'Adapter DPD dopuszcza masę od 10 do 31500 g',
  );
  ensure(
    m.weight_grams % 10 === 0,
    422,
    'Adapter DPD wymaga masy w krokach 10 g; pomiar nie będzie zaokrąglany',
  );
  ensure(
    [m.length_mm, m.width_mm, m.height_mm].every((v) => v % 10 === 0),
    422,
    'Adapter DPD wymaga wymiarów w pełnych cm, czyli wielokrotności 10 mm; pomiar nie będzie zaokrąglany',
  );
  ensure(
    [m.length_mm, m.width_mm, m.height_mm].every((v) => v <= 1750),
    422,
    'Adapter DPD dopuszcza każdy wymiar do 1750 mm',
  );
  return {
    weight: m.weight_grams / 1000,
    dimensions: {
      length: m.length_mm / 10,
      width: m.width_mm / 10,
      height: m.height_mm / 10,
    },
  };
}
