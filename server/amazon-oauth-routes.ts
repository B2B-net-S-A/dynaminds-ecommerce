import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { IntegrationContext } from './channel-access';
import { tokenHash } from './security';
import {
  AMAZON_CALLBACK,
  amazonOAuthInput,
  amazonOAuthFinish,
  amazonLoginInput,
  cachedAmazonAccount,
  beginAmazonOAuth,
  cancelAmazonOAuth,
  finishAmazonOAuth,
  finishAmazonReturn,
  continueAmazonLogin,
} from './amazon-oauth';
export function registerAmazonOAuthRoutes(
  app: FastifyInstance,
  ctx: IntegrationContext,
  sessionName: string,
) {
  const session = (req: any) => tokenHash(req.cookies[sessionName] ?? '');
  const id = (params: unknown) => z.object({ id: z.uuid() }).parse(params).id;
  app.get('/api/integrations/:id/amazon-account', (req) =>
    cachedAmazonAccount(req.actor, session(req), id(req.params)),
  );
  app.post('/api/integrations/:id/amazon-oauth/start', (req) => {
    return beginAmazonOAuth(
      req.actor,
      session(req),
      id(req.params),
      amazonOAuthInput.parse(req.body ?? {}),
    );
  });
  app.post('/api/integrations/:id/amazon-oauth/cancel', (req) => {
    z.object({})
      .strict()
      .parse(req.body ?? {});
    return cancelAmazonOAuth(req.actor, session(req), id(req.params));
  });
  app.post('/api/oauth/amazon/finish', (req) => {
    const b = z
      .object({ return_url: z.string().min(1).max(8192) })
      .strict()
      .parse(req.body);
    return finishAmazonReturn(req.actor, session(req), b.return_url, ctx);
  });
  app.get(AMAZON_CALLBACK, async (req, reply) => {
    const result = await finishAmazonOAuth(
      req.actor,
      session(req),
      amazonOAuthFinish.parse(req.query),
      ctx,
      req.protocol + '://' + req.headers.host + AMAZON_CALLBACK,
    );
    return reply.redirect(
      '/?integration=' + (result.status === 'denied' ? 'amazon_denied' : 'connected'),
    );
  });
  app.get('/api/oauth/amazon/login', async (req, reply) => {
    const result = await continueAmazonLogin(
      req.actor,
      session(req),
      amazonLoginInput.parse(req.query),
    );
    return reply.redirect(result.url);
  });
}
