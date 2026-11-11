import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  configureShopifyWebhooks,
  shopifyWebhookHistory,
  shopifyWebhookInput,
  receiveShopifyWebhook,
  retryShopifyWebhook,
  exampleShopifyWebhook,
} from './shopify-webhooks';
export function registerShopifyWebhookRoutes(app: FastifyInstance) {
  const id = (v: unknown) => z.object({ id: z.uuid() }).parse(v).id;
  app.get('/api/integrations/:id/shopify-webhooks', (req) =>
    shopifyWebhookHistory(req.actor, id(req.params)),
  );
  app.patch('/api/integrations/:id/shopify-webhooks', (req) =>
    configureShopifyWebhooks(req.actor, id(req.params), shopifyWebhookInput.parse(req.body)),
  );
  app.post('/api/shopify-webhook-deliveries/:id/retry', (req) => {
    z.object({})
      .strict()
      .parse(req.body ?? {});
    return retryShopifyWebhook(req.actor, id(req.params));
  });
  app.post('/api/integrations/:id/shopify-webhooks/example', (req) =>
    exampleShopifyWebhook(
      req.actor,
      id(req.params),
      z
        .object({ kind: z.enum(['created', 'updated', 'cancelled']) })
        .strict()
        .parse(req.body).kind,
    ),
  );
  app.register(async (receiver) => {
    receiver.removeContentTypeParser('application/json');
    receiver.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) =>
      done(null, body),
    );
    receiver.post('/api/webhooks/shopify/:id', async (req, reply) =>
      reply
        .code(200)
        .send(await receiveShopifyWebhook(id(req.params), req.body as Buffer, req.headers)),
    );
  });
}
