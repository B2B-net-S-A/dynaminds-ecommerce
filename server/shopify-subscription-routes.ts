import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { IntegrationContext } from './channel-access';
import {
  shopifySubscriptionInput,
  subscriptionHistory,
  refreshShopifySubscriptions,
  previewShopifySubscription,
  queueShopifySubscription,
  cancelShopifySubscription,
  reconcileShopifySubscription,
} from './shopify-subscriptions';
export function registerShopifySubscriptionRoutes(app: FastifyInstance, ctx: IntegrationContext) {
  const id = (p: unknown) => z.object({ id: z.uuid() }).parse(p).id;
  const empty = (p: unknown) =>
    z
      .object({})
      .strict()
      .parse(p ?? {});
  app.get('/api/integrations/:id/shopify-subscriptions', (req) =>
    subscriptionHistory(req.actor, id(req.params)),
  );
  app.post('/api/integrations/:id/shopify-subscriptions/read', (req) => {
    empty(req.body);
    return refreshShopifySubscriptions(req.actor, id(req.params), ctx);
  });
  app.post('/api/integrations/:id/shopify-subscriptions/preview', (req) =>
    previewShopifySubscription(
      req.actor,
      id(req.params),
      shopifySubscriptionInput.parse(req.body),
      ctx,
    ),
  );
  app.post('/api/shopify-subscription-plans/:id/queue', (req) =>
    queueShopifySubscription(
      req.actor,
      id(req.params),
      z
        .object({ external_authorized: z.boolean().default(false) })
        .strict()
        .parse(req.body ?? {}).external_authorized,
    ),
  );
  app.post('/api/shopify-subscription-plans/:id/cancel', (req) => {
    empty(req.body);
    return cancelShopifySubscription(req.actor, id(req.params));
  });
  app.post('/api/shopify-subscription-plans/:id/reconcile', (req) => {
    empty(req.body);
    return reconcileShopifySubscription(req.actor, id(req.params), ctx);
  });
}
