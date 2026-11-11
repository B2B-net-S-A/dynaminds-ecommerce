import { z } from 'zod';

/** Stage106 explicitly bounds UTF-16 units; the previous Zod bound counted code points. */
export const productSkuSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => value.length <= 80, 'SKU może mieć maksymalnie 80 znaków UTF-16')
  .refine(
    (value) =>
      !value.includes('\0') &&
      !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value),
    'SKU wymaga poprawnego Unicode bez NUL',
  );
