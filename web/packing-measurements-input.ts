export type PackingMeasurements = {
  weight_grams: number;
  length_mm: number;
  width_mm: number;
  height_mm: number;
};

export type PackingCartonSeed = {
  id: string;
  version: string;
  code: string;
  label: string;
  outer_length_mm: number;
  outer_width_mm: number;
  outer_height_mm: number;
  tare_weight_grams: number;
};

export type PackingMeasurementsDraft = {
  weight_kg: string;
  length_cm: string;
  width_cm: string;
  height_cm: string;
};

export type PackingMeasurementDraftField = keyof PackingMeasurementsDraft;
export type PackingMeasurementsValidation = {
  measurements: PackingMeasurements | null;
  errors: Partial<Record<PackingMeasurementDraftField, string>>;
};

export const packingMeasurementFields: {
  draft: PackingMeasurementDraftField;
  measurement: keyof PackingMeasurements;
  label: string;
  precision: number;
  maximum: bigint;
  range: string;
}[] = [
  {
    draft: 'weight_kg',
    measurement: 'weight_grams',
    label: 'Masa gotowej paczki (kg)',
    precision: 3,
    maximum: 1000000n,
    range: '0,001–1000 kg',
  },
  {
    draft: 'length_cm',
    measurement: 'length_mm',
    label: 'Długość gotowej paczki (cm)',
    precision: 1,
    maximum: 3000n,
    range: '0,1–300 cm',
  },
  {
    draft: 'width_cm',
    measurement: 'width_mm',
    label: 'Szerokość gotowej paczki (cm)',
    precision: 1,
    maximum: 3000n,
    range: '0,1–300 cm',
  },
  {
    draft: 'height_cm',
    measurement: 'height_mm',
    label: 'Wysokość gotowej paczki (cm)',
    precision: 1,
    maximum: 3000n,
    range: '0,1–300 cm',
  },
];

/** Validate the unchanged input text and convert only valid decimals to g/mm. */
export function validatePackingMeasurementsDraft(
  draft: PackingMeasurementsDraft,
): PackingMeasurementsValidation {
  const errors: PackingMeasurementsValidation['errors'] = {};
  const measurements = {} as PackingMeasurements;
  for (const field of packingMeasurementFields) {
    const raw = draft[field.draft];
    if (!raw) {
      errors[field.draft] = 'Podaj rzeczywisty pomiar gotowej paczki.';
      continue;
    }
    if (
      /\s/.test(raw) ||
      !new RegExp('^(0|[1-9]\\d*)(?:[.,]\\d{1,' + field.precision + '})?$').test(raw)
    ) {
      errors[field.draft] =
        'Podaj dodatnią liczbę bez spacji, znaku i wykładnika; maksymalnie ' +
        field.precision +
        ' miejsc po przecinku lub kropce.';
      continue;
    }
    const [whole, fraction = ''] = raw.split(/[.,]/);
    if (whole.length > 4) {
      errors[field.draft] = 'Dopuszczalny zakres: ' + field.range + '.';
      continue;
    }
    const base =
      BigInt(whole) * 10n ** BigInt(field.precision) +
      BigInt(fraction.padEnd(field.precision, '0'));
    if (base < 1n || base > field.maximum) {
      errors[field.draft] = 'Dopuszczalny zakres: ' + field.range + '.';
      continue;
    }
    measurements[field.measurement] = Number(base);
  }
  return { measurements: Object.keys(errors).length ? null : measurements, errors };
}

export function packingUnitText(base: number, precision: number): string {
  const value = BigInt(base);
  const factor = 10n ** BigInt(precision);
  const fraction = String(value % factor)
    .padStart(precision, '0')
    .replace(/0+$/, '');
  return String(value / factor) + (fraction ? ',' + fraction : '');
}
