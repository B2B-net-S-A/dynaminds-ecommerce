import { z } from 'zod';
import { ensure } from './errors';
export const shopifySubscriptionTopics = [
  'ORDERS_CREATE',
  'ORDERS_UPDATED',
  'ORDERS_PAID',
  'ORDERS_CANCELLED',
  'ORDERS_FULFILLED',
  'REFUNDS_CREATE',
] as const;
export const shopifySubscriptionFields =
  'id topic uri format filter includeFields apiVersion { handle }';
export const subscriptionId = z
  .string()
  .regex(/^gid:\/\/shopify\/WebhookSubscription\/[1-9]\d{0,19}$/);
export const shopifySubscriptionSchema = z.object({
  id: subscriptionId,
  topic: z.string().regex(/^[A-Z][A-Z0-9_]{1,100}$/),
  uri: z.string().min(1).max(2048),
  format: z.enum(['JSON', 'XML']),
  filter: z.string().max(8192).nullable(),
  includeFields: z.array(z.string().min(1).max(200)).max(100),
  apiVersion: z.object({ handle: z.string().regex(/^\d{4}-(01|04|07|10)$/) }),
});
export type ShopifySubscription = z.infer<typeof shopifySubscriptionSchema>;
export const subscriptionBody = z
  .object({
    topic: z.enum(shopifySubscriptionTopics),
    webhookSubscription: z.object({
      uri: z.string().url().max(2048),
      format: z.literal('JSON'),
      includeFields: z.array(z.string()).min(1).max(2),
    }),
  })
  .strict();
export function subscriptionFieldsFor(topic: string) {
  return topic === 'REFUNDS_CREATE' ? ['id', 'order_id'] : ['id', 'admin_graphql_api_id'];
}
export function parseShopifySubscription(raw: unknown) {
  const p = shopifySubscriptionSchema.safeParse(raw);
  ensure(p.success, 502, 'Nieprawidłowa subskrypcja webhooka Shopify');
  return p.data;
}
