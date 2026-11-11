import { z } from 'zod';

export const REPLENISHMENT_LIMITS = {
  products: 500,
  purchase_order_lines: 200,
  rows_page: 100,
  history_page: 25,
  choices: 200,
  contributors: 10000,
  request_bytes: 262144,
  preview_bytes: 8388608,
  response_bytes: 5242880,
  evidence_bytes: 134217728,
  previews: 2000,
  executions: 2000,
  preview_ttl_seconds: 900,
} as const;
export const REPLENISHMENT_CURRENCIES = ['PLN', 'EUR', 'USD', 'GBP', 'CZK'] as const;
const uuid = z.uuid().transform((v) => v.toLowerCase());
const version = z.number().int().positive().max(2147483647);
const quantity = z.number().int().min(0).max(2147483647);
const safeText = z
  .string()
  .trim()
  .max(80)
  .refine(
    (v) => v.length <= 80 && !v.includes('\0') && Buffer.from(v).toString('utf8') === v,
    'Nieprawidłowy kod dostawcy',
  );
export const replenishmentPolicyDefinitionInput = z
  .strictObject({
    enabled: z.boolean(),
    minimum_quantity: quantity,
    target_quantity: quantity,
    supplier_id: uuid,
    supplier_sku: safeText.default(''),
    currency: z.enum(REPLENISHMENT_CURRENCIES),
    minimum_order_quantity: z.number().int().min(1).max(1000000),
    order_multiple: z.number().int().min(1).max(1000000),
    unit_cost_minor: z.number().int().min(0).max(1000000000).nullable(),
    cost_valid_until: z.iso.datetime({ offset: true }).nullable(),
    expected_date: z.iso.date().nullable().default(null),
    confirm_cost: z.boolean().default(false),
  })
  .refine((v) => v.target_quantity >= v.minimum_quantity, 'Cel nie może być mniejszy od minimum')
  .refine(
    (v) => v.unit_cost_minor !== null || v.cost_valid_until === null,
    'Nieznany koszt nie może mieć terminu ważności',
  );
export const replenishmentPolicyCreateInput = z.strictObject({
  client_key: uuid,
  warehouse_id: uuid,
  product_id: uuid,
  definition: replenishmentPolicyDefinitionInput,
});
export const replenishmentPolicyPatchInput = z.strictObject({
  version,
  definition: replenishmentPolicyDefinitionInput,
});
export const replenishmentForecastInput = z.strictObject({
  lookback_days: z.union([
    z.literal(7),
    z.literal(14),
    z.literal(30),
    z.literal(60),
    z.literal(90),
  ]),
  coverage_days: z.number().int().min(1).max(365),
});
export const replenishmentPreviewInput = z.strictObject({
  client_key: uuid,
  warehouse_id: uuid,
  forecast: replenishmentForecastInput.optional(),
  draft_targets: z
    .array(
      z.strictObject({
        supplier_id: uuid,
        currency: z.enum(REPLENISHMENT_CURRENCIES),
        purchase_order_id: uuid,
        version,
      }),
    )
    .min(1)
    .max(500)
    .refine(
      (v) => new Set(v.map((t) => t.supplier_id + ':' + t.currency)).size === v.length,
      'Powtórzony dostawca i waluta szkicu',
    )
    .refine(
      (v) => new Set(v.map((t) => t.purchase_order_id)).size === v.length,
      'Powtórzone szkice',
    )
    .transform((v) =>
      [...v].sort((a, b) =>
        (a.supplier_id + ':' + a.currency).localeCompare(b.supplier_id + ':' + b.currency),
      ),
    )
    .optional(),
  items: z
    .array(z.strictObject({ product_id: uuid, product_version: version, policy_version: version }))
    .min(1)
    .max(500)
    .refine((v) => new Set(v.map((x) => x.product_id)).size === v.length, 'Powtórzone produkty')
    .transform((v) => [...v].sort((a, b) => a.product_id.localeCompare(b.product_id))),
});
export const replenishmentExecuteInput = z.strictObject({
  client_key: uuid,
  scope_hash: z.string().regex(/^[0-9a-f]{64}$/),
  confirmed: z.literal(true),
});
export const replenishmentPageQuery = z.strictObject({
  cursor: z.string().max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
});
export const replenishmentSelectionQuery = replenishmentPageQuery.extend({
  warehouse_id: uuid,
  search: z
    .string()
    .max(200)
    .refine((v) => !v.includes('\0'))
    .default(''),
});
export const replenishmentPoliciesQuery = replenishmentPageQuery.extend({ warehouse_id: uuid });
export const replenishmentExecutionsQuery = z.strictObject({
  warehouse_id: uuid.optional(),
  cursor: z.string().max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(25).default(25),
});
export type ReplenishmentDefinition = Omit<
  z.infer<typeof replenishmentPolicyDefinitionInput>,
  'confirm_cost'
> & { cost_confirmed_at: string | null };
export type ReplenishmentPreviewInput = z.infer<typeof replenishmentPreviewInput>;

export const replenishmentDraftsQuery = replenishmentPageQuery.extend({
  warehouse_id: uuid,
  supplier_id: uuid,
  currency: z.enum(REPLENISHMENT_CURRENCIES),
});
