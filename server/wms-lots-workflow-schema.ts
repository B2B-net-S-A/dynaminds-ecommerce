import { z } from 'zod';
import { wmsStockVersion, wmsReceiptLine, wmsDecimal } from './wms-lots-schema';
const wmsVersion = wmsDecimal.refine((v) => BigInt(v) > 0n, 'Wersja musi być dodatnia');

export const purchaseWmsLots = z.strictObject({
  policy_version: wmsVersion,
  stock_versions: z.array(wmsStockVersion).min(1).max(500),
  lines: z
    .array(
      wmsReceiptLine
        .omit({ unit_cost_minor: true, currency: true })
        .extend({
          unit_cost_minor: wmsReceiptLine.shape.unit_cost_minor.optional(),
          currency: wmsReceiptLine.shape.currency.optional(),
        })
        .strict(),
    )
    .min(1)
    .max(500),
});

export const returnWmsLots = z.strictObject({
  client_key: z.uuid(),
  policy_version: wmsVersion,
  stock_versions: z.array(wmsStockVersion).min(1).max(500),
  picks: z
    .array(
      z.strictObject({
        issue_fragment_id: z.uuid(),
        quantity: z.number().int().min(1).max(1000000),
        location: wmsReceiptLine.shape.location,
      }),
    )
    .max(500),
});
