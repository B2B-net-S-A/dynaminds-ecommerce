import { z } from 'zod';
export const orderFieldType = z.enum([
  'text',
  'number',
  'select',
  'radio',
  'multi_select',
  'date',
  'file',
]);
const common = { field_id: z.uuid(), definition_version: z.number().int().positive() };
const characters = (max: number) =>
  z
    .string()
    .max(max * 2)
    .refine((v) => [...v].length <= max, 'Przekroczony limit znaków');
export const orderFieldSetSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...common, type: z.literal('text'), value: characters(4000) }),
  z.strictObject({ ...common, type: z.literal('number'), value: z.string().max(26) }),
  z.strictObject({ ...common, type: z.literal('select'), value: z.uuid() }),
  z.strictObject({ ...common, type: z.literal('radio'), value: z.uuid() }),
  z.strictObject({ ...common, type: z.literal('multi_select'), value: z.array(z.uuid()).max(50) }),
  z.strictObject({ ...common, type: z.literal('date'), value: z.string().length(10) }),
  z.strictObject({ ...common, type: z.literal('file'), value: z.uuid() }),
]);
export const orderFieldChangeSchema = z.union([
  orderFieldSetSchema,
  z.strictObject({ ...common, operation: z.literal('clear') }),
]);
export const initialOrderFieldsSchema = z.array(orderFieldSetSchema).max(20);
export const orderFieldPatchSchema = z.strictObject({
  client_key: z.uuid(),
  order_version: z.number().int().positive(),
  changes: z.array(orderFieldChangeSchema).min(1).max(20),
});
export const orderFieldOptionSchema = z.strictObject({
  id: z.uuid(),
  label: characters(120)
    .transform((v) => v.trim())
    .refine((v) => v.length > 0),
  enabled: z.boolean().default(true),
});
const editable = {
  label: characters(120)
    .transform((v) => v.trim())
    .refine((v) => v.length > 0),
  enabled: z.boolean().default(true),
  display: z.enum(['always', 'edit_only']).default('always'),
  position: z.number().int().min(0).max(10000).default(0),
  read_role: z.enum(['team', 'admin']).default('team'),
  write_role: z.enum(['operator', 'admin']).default('operator'),
  required_on: z
    .array(z.enum(['manual_create', 'pack_complete']))
    .max(2)
    .default([]),
  config: z.record(z.string(), z.unknown()).default({}),
  options: z.array(orderFieldOptionSchema).max(100).default([]),
};
export const orderFieldDefinitionSchema = z.strictObject({
  client_key: z.uuid(),
  key: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  type: orderFieldType,
  ...editable,
});
export const orderFieldDefinitionPatchSchema = z.strictObject({
  version: z.number().int().positive(),
  ...editable,
});
export const orderFieldDisableSchema = z.strictObject({ version: z.number().int().positive() });
export const orderFieldFiltersSchema = z
  .array(
    z.strictObject({
      ...common,
      operator: z.enum([
        'is_set',
        'is_unset',
        'eq',
        'neq',
        'contains',
        'prefix',
        'gte',
        'lte',
        'contains_option',
      ]),
      value: z.unknown().optional(),
    }),
  )
  .max(5);
export const orderFieldColumnsSchema = z.array(z.uuid()).max(10);
export const orderFieldFileSchema = z.strictObject({
  client_key: z.uuid(),
  order_id: z.uuid(),
  field_id: z.uuid(),
  definition_version: z.number().int().positive(),
  filename: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[^\/\\\u0000-\u001f\u007f]*$/),
  content_base64: z.string().min(4).max(6990508),
});
export const orderFieldHistorySchema = z.strictObject({ cursor: z.string().max(300).optional() });
export type OrderFieldChange = z.infer<typeof orderFieldChangeSchema>;
export type OrderFieldSet = z.infer<typeof orderFieldSetSchema>;
