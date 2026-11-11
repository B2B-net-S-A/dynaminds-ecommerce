import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { IntegrationContext } from './channel-access';
import { tokenHash } from './security';
import { SHOPIFY_CALLBACK, shopifyOAuthInput } from './shopify-auth-input';
import { readShopifyLocales } from './shopify-locales';
import { ensure } from './errors';
import {
  cachedShopifyAccount,
  beginShopifyOAuth,
  cancelShopifyOAuth,
  finishShopifyReturn,
} from './shopify-oauth';
export function registerShopifyOAuthRoutes(
  app: FastifyInstance,
  ctx: IntegrationContext,
  sessionName: string,
  readOnly = false,
) {
  const session = (req: any) => tokenHash(req.cookies[sessionName] ?? '');
  const id = (v: unknown) => z.object({ id: z.uuid() }).parse(v).id;
  app.get('/api/integrations/:id/shopify-locales', async (req) => {
    ensure(!readOnly, 423, 'Odczyt języków dostawcy jest wyłączony w podglądzie kopii');
    return readShopifyLocales(req.actor, id(req.params), ctx);
  });
  app.get('/api/integrations/:id/shopify-account', (req) =>
    cachedShopifyAccount(req.actor, session(req), id(req.params)),
  );
  app.post('/api/integrations/:id/shopify-oauth/start', (req) =>
    beginShopifyOAuth(
      req.actor,
      session(req),
      id(req.params),
      shopifyOAuthInput.parse(req.body ?? {}),
    ),
  );
  app.post('/api/integrations/:id/shopify-oauth/cancel', (req) => {
    z.object({})
      .strict()
      .parse(req.body ?? {});
    return cancelShopifyOAuth(req.actor, session(req), id(req.params));
  });
  app.post('/api/oauth/shopify/finish', (req) =>
    finishShopifyReturn(
      req.actor,
      session(req),
      z
        .object({ return_url: z.string().min(1).max(8192) })
        .strict()
        .parse(req.body).return_url,
      ctx,
    ),
  );
  app.get(SHOPIFY_CALLBACK, async (req, reply) => {
    await finishShopifyReturn(
      req.actor,
      session(req),
      req.protocol + '://' + req.headers.host + req.raw.url,
      ctx,
    );
    return reply.redirect('/?integration=shopify_connected');
  });
}
