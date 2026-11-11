import { z } from 'zod';

export const PRODUCT_LOGISTICS_FIELDS = [
  'weight_grams',
  'length_mm',
  'width_mm',
  'height_mm',
  'manufacturer',
] as const;
const manufacturer = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(
    (v) =>
      !v.includes('\0') &&
      !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(v),
    'Producent wymaga poprawnego Unicode bez NUL',
  );
const weight = z.number().int().min(1).max(100000000).nullable();
const dimension = z.number().int().min(1).max(100000).nullable();
export const productLogisticsValuesSchema = z.strictObject({
  weight_grams: weight,
  length_mm: dimension,
  width_mm: dimension,
  height_mm: dimension,
  manufacturer: manufacturer.nullable(),
});
export const productLogisticsFields = {
  weight_grams: weight.optional(),
  length_mm: dimension.optional(),
  width_mm: dimension.optional(),
  height_mm: dimension.optional(),
  manufacturer: manufacturer.nullable().optional(),
};
export const productLogisticsPatchSchema = z.strictObject(productLogisticsFields);
export type ProductLogisticsValues = z.infer<typeof productLogisticsValuesSchema>;
export type ProductLogisticsPatch = z.infer<typeof productLogisticsPatchSchema>;
export const unknownProductLogistics = (): ProductLogisticsValues => ({
  weight_grams: null,
  length_mm: null,
  width_mm: null,
  height_mm: null,
  manufacturer: null,
});
