import { z } from 'zod';
import { stages, condition, orderAction } from './operation-schema';
import { isCustomerWorkflowAction } from './customer-message-workflow-schema';
export const scheduleInput = z
  .object({
    name: z.string().trim().min(2).max(120),
    enabled: z.boolean().default(false),
    frequency: z.discriminatedUnion('kind', [
      z
        .object({ kind: z.literal('interval'), seconds: z.number().int().min(60).max(604800) })
        .strict(),
      z
        .object({
          kind: z.literal('daily'),
          time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
          timezone: z.string().min(1).max(80),
          weekdays: z
            .array(z.number().int().min(1).max(7))
            .min(1)
            .max(7)
            .refine((v) => new Set(v).size === v.length, 'Powtórzony dzień tygodnia'),
        })
        .strict(),
    ]),
    statuses: z
      .array(z.enum(stages))
      .min(1)
      .max(stages.length)
      .refine((v) => new Set(v).size === v.length, 'Powtórzony etap'),
    min_age_seconds: z.number().int().min(0).max(31536000).default(0),
    repetition: z.enum(['once_per_version', 'each_run']).default('once_per_version'),
    match: z.enum(['all', 'any']).default('all'),
    conditions: z.array(condition).max(10).default([]),
    actions: z
      .array(orderAction)
      .min(1)
      .max(5)
      .refine(
        (actions) => !actions.some(isCustomerWorkflowAction),
        'Akcje wiadomości nie obsługują harmonogramów',
      ),
  })
  .strict();
export type ScheduleInput = z.infer<typeof scheduleInput>;
export const scheduleCreate = scheduleInput.extend({ client_key: z.uuid() });
export const scheduleEdit = scheduleInput.extend({ version: z.string().regex(/^\d+$/) });
export const scheduleQueue = z
  .object({ version: z.string().regex(/^\d+$/), client_key: z.uuid(), confirmed: z.literal(true) })
  .strict();
