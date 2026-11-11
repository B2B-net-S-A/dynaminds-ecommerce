import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ensure } from './errors';
import { tenantTx } from './db';
import type { IntegrationContext } from './channel-access';
import {
  translationPublicationInput,
  translationConsent,
  translationHistory,
  translationDetail,
  previewTranslation,
  queueTranslation,
  cancelTranslation,
  reconcileTranslation,
} from './shopify-translations';
export function registerShopifyTranslationRoutes(
  app: FastifyInstance,
  ctx: IntegrationContext,
  opts: { available: boolean; readOnly: boolean },
) {
  const id = (p: unknown) => z.object({ id: z.uuid() }).parse(p).id;
  const page = (q: unknown) =>
    z
      .object({ cursor: z.string().max(300).optional() })
      .strict()
      .parse(q).cursor;
  const available = () =>
    ensure(opts.available, 503, 'Kopia nie zawiera publikacji tłumaczeń Shopify');
  const writable = () => {
    available();
    ensure(!opts.readOnly, 423, 'Publikacja i odczyty dostawcy są wyłączone w podglądzie kopii');
  };
  const empty = (v: unknown) => z.strictObject({}).parse(v ?? {});
  app.get('/api/products/:id/shopify-translations', async (req) => {
    ensure(req.actor.role === 'admin', 403, 'Wymagany administrator');
    if (!opts.available) {
      await tenantTx(req.actor.tenantId, async (c) => {
        ensure(
          (await c.query('SELECT id FROM products WHERE id=$1', [id(req.params)])).rowCount,
          404,
          'Nie znaleziono produktu',
        );
      });
      return {
        available: false,
        read_only: opts.readOnly,
        data: [],
        mappings: [],
        translations: [],
        meta: { cursor: null },
      };
    }
    return {
      available: true,
      read_only: opts.readOnly,
      ...(await translationHistory(req.actor, id(req.params), page(req.query))),
    };
  });
  app.get('/api/shopify-translation-plans/:id', async (req) => {
    available();
    return {
      read_only: opts.readOnly,
      ...(await translationDetail(req.actor, id(req.params), page(req.query))),
    };
  });
  app.post('/api/products/:id/shopify-translations/preview', (req) => {
    writable();
    return previewTranslation(
      req.actor,
      id(req.params),
      translationPublicationInput.parse(req.body),
      ctx,
    );
  });
  app.post('/api/shopify-translation-plans/:id/queue', (req) => {
    writable();
    return queueTranslation(req.actor, id(req.params), translationConsent.parse(req.body ?? {}));
  });
  app.post('/api/shopify-translation-plans/:id/cancel', (req) => {
    writable();
    empty(req.body);
    return cancelTranslation(req.actor, id(req.params));
  });
  app.post('/api/shopify-translation-plans/:id/reconcile', (req) => {
    writable();
    empty(req.body);
    return reconcileTranslation(req.actor, id(req.params), ctx);
  });
  app.post('/api/shopify-translation-plans/:id/acknowledge', (req) => {
    writable();
    z.strictObject({ acknowledge_unconfirmed: z.literal(true) }).parse(req.body);
    return reconcileTranslation(req.actor, id(req.params), ctx, true);
  });
}
