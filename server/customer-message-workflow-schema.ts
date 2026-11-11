import { z } from 'zod';
export const customerWorkflowBody = z
  .string()
  .trim()
  .refine(
    (s) => Array.from(s).length >= 1 && Array.from(s).length <= 4000,
    'Treść musi mieć1..4000 znaków',
  )
  .refine(
    (s) => Buffer.byteLength(s, 'utf8') <= 16384 && Buffer.from(s, 'utf8').toString('utf8') === s,
    'Nieprawidłowy tekst UTF8',
  )
  .regex(/^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/, 'Treść zawiera niedozwolone znaki')
  .transform((s) => s.replace(/\r\n?/g, '\n'));
export const customerWorkflowActions = [
  z.strictObject({ type: z.literal('customer_message_reply'), body: customerWorkflowBody }),
  z.strictObject({ type: z.literal('customer_message_note'), body: customerWorkflowBody }),
  z.strictObject({
    type: z.literal('customer_message_assign'),
    assigned_user_id: z.uuid().nullable(),
  }),
  z.strictObject({
    type: z.literal('customer_message_status'),
    status: z.enum(['open', 'closed']),
  }),
] as const;
export const customerWorkflowAction = z.discriminatedUnion('type', customerWorkflowActions);
export type CustomerWorkflowAction = z.infer<typeof customerWorkflowAction>;
export const customerMessageAssignment = z.strictObject({
  assigned_user_id: z.uuid().nullable(),
  version: z.number().int().positive(),
});
export const customerWorkflowPage = z.strictObject({
  cursor: z.string().max(300).optional(),
  order_id: z.uuid().optional(),
});
export const customerWorkflowAssigneePage = z.strictObject({ cursor: z.uuid().optional() });
export const isCustomerWorkflowAction = (a: { type: string }): a is CustomerWorkflowAction =>
  a.type.startsWith('customer_message_');
