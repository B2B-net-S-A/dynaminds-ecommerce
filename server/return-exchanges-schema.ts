import { z } from 'zod';
import { returnWmsLots } from './wms-lots-workflow-schema';

const uuid = z.uuid().transform((v) => v.toLowerCase());
const item = z
  .strictObject({
    item_id: uuid,
    accepted: z.number().int().min(0).max(100000),
    restocked: z.number().int().min(0).max(100000),
    replacement_product_id: uuid.optional(),
  })
  .refine((v) => v.restocked <= v.accepted, 'Przywracana ilość przekracza przyjętą')
  .refine(
    (v) => v.accepted > 0 || v.replacement_product_id === undefined,
    'Wybór zamiennika wymaga przyjętej ilości',
  );
export const returnExchangePreviewInput = z
  .strictObject({
    version: z.number().int().positive().max(2147483647),
    warehouse_id: uuid,
    note: z.string().trim().min(3).max(2000),
    items: z.array(item).min(1).max(100),
    origin_id: uuid.optional(),
    wms_lots: returnWmsLots.optional(),
  })
  .refine(
    (v) => new Set(v.items.map((i) => i.item_id)).size === v.items.length,
    'Powtórzona pozycja reklamacji',
  )
  .refine(
    (v) => v.items.some((i) => i.accepted > 0),
    'Wymiana wymaga przyjęcia przynajmniej jednej sztuki',
  );
export const returnExchangeInput = returnExchangePreviewInput.safeExtend({
  client_key: uuid,
  scope_hash: z.string().regex(/^[a-f0-9]{64}$/),
  confirmed: z.literal(true),
});
export type ReturnExchangePreviewInput = z.infer<typeof returnExchangePreviewInput>;
export type ReturnExchangeInput = z.infer<typeof returnExchangeInput>;
