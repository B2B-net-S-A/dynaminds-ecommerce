import { z } from 'zod';
import { replenishmentForecastInput } from './replenishment-plans-schema';
export const REPLENISHMENT_AUTOMATION_LIMITS = {
  rules: 200,
  products: 500,
  pending: 200,
  runs: 2000,
  rows_page: 100,
  request_bytes: 262144,
  evidence_bytes: 134217728,
} as const;
const uuid = z.uuid().transform((v) => v.toLowerCase());
const version = z.number().int().positive().max(2147483647);
const name = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine(
    (v) =>
      v.length <= 120 && !/[\u0000-\u001f\u007f]/.test(v) && Buffer.from(v).toString('utf8') === v,
  );
export const replenishmentAutomationDefinitionInput = z.strictObject({
  warehouse_id: uuid,
  product_ids: z
    .array(uuid)
    .min(1)
    .max(500)
    .refine((v) => new Set(v).size === v.length, 'Powtórzone produkty')
    .transform((v) => [...v].sort()),
  enabled: z.boolean().default(false),
  destination: z.enum(['new_drafts', 'append_matching_draft']),
  forecast: replenishmentForecastInput.optional(),
});
const consent = (v: { definition: { enabled: boolean }; confirmed_future_drafts?: true }) =>
  !v.definition.enabled || v.confirmed_future_drafts === true;
export const replenishmentAutomationCreateInput = z
  .strictObject({
    client_key: uuid,
    name,
    definition: replenishmentAutomationDefinitionInput,
    confirmed_future_drafts: z.literal(true).optional(),
  })
  .refine(consent, 'Włączenie wymaga zgody na przyszłe zmiany lokalnych szkiców PO');
export const replenishmentAutomationPatchInput = z
  .strictObject({
    version,
    name,
    definition: replenishmentAutomationDefinitionInput,
    confirmed_future_drafts: z.literal(true).optional(),
  })
  .refine(consent, 'Włączenie wymaga zgody na przyszłe zmiany lokalnych szkiców PO');
export const replenishmentAutomationPageQuery = z.strictObject({
  cursor: z.string().max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
});
export const replenishmentAutomationRunsQuery = replenishmentAutomationPageQuery.extend({
  rule_id: uuid.optional(),
});
export const replenishmentAutomationCancelInput = z.strictObject({ version, client_key: uuid });
export type ReplenishmentAutomationDefinition = z.infer<
  typeof replenishmentAutomationDefinitionInput
>;
