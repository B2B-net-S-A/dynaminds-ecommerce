import {
  customerWorkflowActions,
  isCustomerWorkflowAction,
} from './customer-message-workflow-schema';
import { emailAction } from './email-actions';
import { smsAction } from './sms-actions';
import { z } from 'zod';
export const stages = [
  'new',
  'paid',
  'picking',
  'packed',
  'shipped',
  'delivered',
  'completed',
  'cancelled',
  'return_initiated',
  'return_received',
  'return_completed',
] as const;
export const triggers = [
  'order.created',
  ...stages.map((s) => 'order.' + s),
  'order.workflow_changed',
  'order.note_added',
  'order.tags_changed',
  'return.photo_created',
  'customer_message.received',
] as const;
// AUTO-07: an own event `custom.<key>` (definitions in custom_event_defs, migration 244).
export const customEventKey = z.string().regex(/^[a-z][a-z0-9_]{1,39}$/);
export const customEventTrigger = z.string().regex(/^custom\.[a-z][a-z0-9_]{1,39}$/);
export const tag = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[\p{L}\p{N} _.-]+$/u);
export const orderAction = z.discriminatedUnion('type', [
  ...customerWorkflowActions,
  smsAction,
  emailAction,
  z.object({
    type: z.literal('sync_local_woo_stock'),
    channel_id: z.uuid(),
    warehouse_id: z.uuid(),
    listing_id: z.uuid().optional(),
    channel_hash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  }).strict(),
  // The call key comes from the rule, schedule or batch; a manual call brings its own (one per attempt).
  z.strictObject({ type: z.literal('raise_event'), event_key: customEventKey, client_key: z.uuid().optional() }),
  z.object({ type: z.literal('add_note'), note: z.string().trim().min(1).max(500) }),
  z.object({ type: z.literal('add_tag'), tag }),
  z.object({ type: z.literal('remove_tag'), tag }),
  z.object({ type: z.literal('set_status'), status: z.enum(stages) }),
  z.object({
    type: z.literal('set_workflow'),
    status_id: z.uuid(),
    status_version: z.string().regex(/^\d+$/).optional(),
  }),
]);
export type OrderAction = z.infer<typeof orderAction>;
export const condition = z.discriminatedUnion('field', [
  z.object({
    field: z.literal('currency'),
    op: z.enum(['eq', 'neq']),
    value: z.string().regex(/^[A-Z]{3}$/),
  }),
  z.object({
    field: z.literal('total'),
    op: z.enum(['gte', 'lte', 'eq']),
    value: z.number().int().min(0).max(2147483647),
  }),
  z.object({
    field: z.literal('item_count'),
    op: z.enum(['gte', 'lte', 'eq']),
    value: z.number().int().min(0).max(10000000),
  }),
  z.object({
    field: z.literal('source'),
    op: z.enum(['eq', 'neq']),
    value: z.string().trim().min(1).max(40),
  }),
  z.object({ field: z.literal('status'), op: z.enum(['eq', 'neq']), value: z.enum(stages) }),
  z.object({
    field: z.literal('country'),
    op: z.enum(['eq', 'neq']),
    value: z.string().regex(/^[A-Z]{2}$/),
  }),
  z.object({ field: z.literal('warehouse_id'), op: z.enum(['eq', 'neq']), value: z.uuid() }),
  z.object({ field: z.literal('workflow_status_id'), op: z.enum(['eq', 'neq']), value: z.uuid() }),
  z.object({ field: z.literal('tag'), op: z.enum(['contains', 'not_contains']), value: tag }),
  z.object({
    field: z.literal('sku'),
    op: z.enum(['contains', 'not_contains']),
    value: z.string().trim().min(1).max(80),
  }),
]);
// AUTO-06: one nesting level. A rule holds up to 10 items (leaves or groups) and
// at most 10 leaves in total; a group holds 1-10 leaves, never another group.
export const conditionGroup = z.strictObject({
  group: z.strictObject({
    match: z.enum(['all', 'any']),
    conditions: z.array(condition).min(1).max(10),
  }),
});
export type ConditionGroup = z.infer<typeof conditionGroup>;
const ruleShape = {
  name: z.string().trim().min(2).max(120),
  trigger: z.union([z.enum(triggers), customEventTrigger]),
  enabled: z.boolean().default(true),
  priority: z.number().int().min(0).max(100).default(50),
  delay_seconds: z.number().int().min(0).max(604800).default(0),
  match: z.enum(['all', 'any']).default('all'),
  conditions: z.array(condition).max(10).default([]),
  actions: z.array(orderAction).min(1).max(5),
};
function messageActionsOnly(r: { trigger: string; actions: OrderAction[] }, ctx: z.RefinementCtx) {
  if (
    (r.trigger !== 'customer_message.received' && r.actions.some(isCustomerWorkflowAction)) ||
    (r.trigger === 'customer_message.received' && !r.actions.every(isCustomerWorkflowAction))
  )
    ctx.addIssue({
      code: 'custom',
      path: ['actions'],
      message: 'Akcje wiadomości są dozwolone tylko dla wiadomości kupującego',
    });
}
// Flat shape: customer-message workflows, schedules and local demo rules stay on it.
export const ruleInput = z.object(ruleShape).superRefine(messageActionsOnly);
// /api/automations and frozen automation payloads; flat input stays a valid subset.
export const automationRuleInput = z
  .object({
    ...ruleShape,
    conditions: z.array(z.union([condition, conditionGroup])).max(10).default([]),
  })
  .superRefine((r, ctx) => {
    messageActionsOnly(r, ctx);
    const groups = r.conditions.filter((c) => 'group' in c);
    if (groups.length && r.trigger === 'customer_message.received')
      ctx.addIssue({
        code: 'custom',
        path: ['conditions'],
        message: 'Grupy warunków są niedostępne dla wiadomości kupującego',
      });
    if (r.conditions.flatMap((c) => ('group' in c ? c.group.conditions : [c])).length > 10)
      ctx.addIssue({
        code: 'custom',
        path: ['conditions'],
        message: 'Reguła może mieć najwyżej 10 warunków łącznie z grupami',
      });
  });
export type AutomationRuleInput = z.infer<typeof automationRuleInput>;
export const conditionLeaves = (r: Pick<AutomationRuleInput, 'conditions'>) =>
  r.conditions.flatMap((c) => ('group' in c ? c.group.conditions : [c]));
export type RuleInput = z.infer<typeof ruleInput>;
export function normalizedRule(r: any): AutomationRuleInput {
  return automationRuleInput.parse({
    name: r.name,
    trigger: r.trigger,
    enabled: r.enabled,
    priority: r.priority,
    delay_seconds: r.delay_seconds,
    ...(r.action === 'add_note'
      ? { actions: [{ type: 'add_note', note: r.config.note }] }
      : r.config),
  });
}
type Condition = z.infer<typeof condition>;
export function matchesCondition(c: Condition, s: any) {
  const value = c.field === 'tag' ? s.tags : c.field === 'sku' ? s.skus : s[c.field];
  switch (c.op) {
    case 'eq':
      return value === c.value;
    case 'neq':
      return value !== c.value;
    case 'gte':
      return value >= c.value;
    case 'lte':
      return value <= c.value;
    case 'contains':
      return Array.isArray(value) && value.includes(c.value);
    case 'not_contains':
      return Array.isArray(value) && !value.includes(c.value);
  }
}
const combine = (match: 'all' | 'any', values: boolean[]) =>
  !values.length || (match === 'any' ? values.some(Boolean) : values.every(Boolean));
export const matchesItem = (c: Condition | ConditionGroup, s: any): boolean =>
  'group' in c
    ? combine(c.group.match, c.group.conditions.map((l) => matchesCondition(l, s)))
    : matchesCondition(c, s);
export function matchesRule(r: Pick<AutomationRuleInput, 'match' | 'conditions'>, s: any) {
  return combine(r.match, r.conditions.map((c) => matchesItem(c, s)));
}
