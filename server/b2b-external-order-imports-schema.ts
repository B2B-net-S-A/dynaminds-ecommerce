import { z } from 'zod';
const uuid = z.uuid().transform((v) => v.toLowerCase());
const quantity = z.number().int().min(0).max(100000);
export const B2B_EXTERNAL_ORDER_IMPORT_LIMITS = {
  items: 100,
  quantity: 100000,
  page_rows: 100,
  previews: 2000,
  preview_bytes: 8388608,
  proof_bytes: 134217728,
} as const;
export const b2bExternalImportPreviewInput = z.strictObject({
  client_key: uuid,
  warehouse_id: uuid,
  expected_source_hash: z.string().regex(/^[a-f0-9]{64}$/),
  allocations: z
    .array(
      z.strictObject({
        remote_line_id: z
          .string()
          .min(1)
          .max(200)
          .refine((v) => !/[\u0000-\u001f\u007f]/.test(v)),
        local_quantity: quantity,
        external_quantity: quantity,
        unassigned_quantity: quantity,
        link_id: uuid.nullable(),
      }),
    )
    .min(1)
    .max(100)
    .superRefine((rows, c) => {
      if (new Set(rows.map((r) => r.remote_line_id)).size !== rows.length)
        c.addIssue({ code: 'custom', message: 'Powtórzona tożsamość źródłowej pozycji' });
      for (const r of rows)
        if (r.external_quantity > 0 !== (r.link_id !== null))
          c.addIssue({ code: 'custom', message: 'Zewnętrzna ilość wymaga jawnego połączenia' });
    }),
});
export const b2bExternalImportExecuteInput = z.strictObject({
  client_key: uuid,
  version: z.literal(1),
  scope_hash: z.string().regex(/^[a-f0-9]{64}$/),
  confirmed: z.literal(true),
});
export const b2bExternalImportPageQuery = z.strictObject({
  cursor: uuid.optional(),
  inbound_id: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type ExternalImportConsent = z.infer<typeof b2bExternalImportExecuteInput> & {
  preview_id: string;
};
